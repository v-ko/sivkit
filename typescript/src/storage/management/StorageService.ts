import { ProjectStorageManager, ProjectStorageConfig, StorageAddon, eraseProjectLocalStorage } from './ProjectStorageManager';
import { Delta, DeltaData } from '../../model/Delta';
import { RepoUpdateData } from "../repository/Repository"
import { createId } from '../../util/base';
import { AddFileResult } from '../file-store/FileStoreAdapter';
import { generateUniquePathWithSuffix } from "../../util/secondary";
import { getLogger } from '../../logging';
import { addChannel, Channel, getChannel, Subscription } from '../../registries/Channel';
import { CommitData } from '../version-control/Commit';
import { CommitGraphData } from '../version-control/CommitGraph';
import { squashBranchHistory } from './sync-utils';

let log = getLogger('StorageService')

// Simple policy: squash commits older than this TTL into the first commit (J=0)
const SQUASH_TTL_MS = 15 * 60 * 1000 // TODO: Should be passed as a parameter

export class RepositoryConfigMismatchError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RepositoryConfigMismatchError";
    }
}

/** Commit/load admission failed because the project's storage is no longer open. */
export class ProjectStorageLifecycleError extends Error {
    constructor(projectId: string) {
        super(`Project ${projectId} storage is closing or not loaded`);
        this.name = 'ProjectStorageLifecycleError';
    }
}

export interface StorageAddonDescriptor {
    name: string;
    create: (psm: ProjectStorageManager) => StorageAddon;
    /** Erases addon-owned local data after teardown, without constructing an addon. */
    eraseLocalStorage?: (config: ProjectStorageConfig) => Promise<void>;
}

export interface ProjectData {
    id: string;
    title: string;
    description: string;
    created: string;
}

export type RepoUpdateNotifiedSignature = (update: RepoUpdateData) => void;

export function deriveProjectUri(projectId: string, adapterName: string): string {
    const encoded = encodeURIComponent(projectId);
    switch (adapterName) {
        case 'IndexedDB':
            return `indexeddb:///${encoded}`;
        case 'RestApi':
            return `file:///${encoded}`;
        default:
            return `project:///${encoded}`;
    }
}

export interface StorageServiceInterface {
    loadProject: (projectId: string, repoManagerConfig: ProjectStorageConfig, projectUri?: string) => Promise<void>;
    createProject: (projectId: string, projectStorageConfig: ProjectStorageConfig) => Promise<string>;
    unloadProject: (projectId: string) => Promise<void>;
    removeProject: (projectId: string, projectStorageConfig: ProjectStorageConfig) => Promise<void>;
    getCommitGraph: (projectId: string) => Promise<CommitGraphData>;
    getCommits: (projectId: string, commitIds: string[]) => Promise<CommitData[]>;
    commit: (projectId: string, deltaData: DeltaData, message: string) => Promise<CommitOperationResult>;
    sendToAddon: (projectId: string, addonName: string, message: unknown) => Promise<unknown>;

    // File operations
    addFile: (projectId: string, blob: Blob, path: string) => Promise<AddFileResult>;
    getFile: (projectId: string, path: string) => Promise<Blob>;
    removeFile: (projectId: string, path: string) => Promise<void>;

    test(): boolean;
    disconnect: () => void;
}

export interface CommitOperationResult {
    type: 'commit';
    commit: CommitData;
}

export interface LocalStorageUpdateMessage {
    type: 'repoUpdate';
    projectId: string;
    storageServiceId: string;
    update: RepoUpdateData;
}

export interface ServiceErrorMessage {
    type: 'error';
    message: string;
}

export type StorageChannelMessage = LocalStorageUpdateMessage | ServiceErrorMessage;

export const LOCAL_STORAGE_UPDATE_CHANNEL = 'storage-service-local-storage-update-channel';

// Helper to create a storage channel with backend auto-selection
// The policy here is to create the channel for the app scope and reuse it
// Cleanup is not a concern until it becomes one
export function getStorageUpdatesChannel(name: string): Channel {
    const backend = (typeof BroadcastChannel !== 'undefined') ? 'broadcast' : 'local';
    let channel = getChannel(name);
    if (!channel) {
        channel = addChannel(name, { backend: backend });
    }
    return channel
}

export class StorageService implements StorageServiceInterface {
    /**
     * This service provides an interface for the storage management.
     *
     * When the service worker is available - it's run in it and is used via
     * wrappers in all windows/tabs (to save on resources).
     *
     * Uses reference counting to manage repository lifecycle - repos are loaded
     * on first request and unloaded when no more references exist.
     */
    id: string = createId(8)
    private repoManagers: { [key: string]: ProjectStorageManager } = {}; // Per projectId
    private repoRefCounts: { [key: string]: number } = {}; // Per projectId - reference counting
    // Creation owns a temporary manager; loading owns the shared manager above.
    private _creations = new Map<string, Promise<void>>();
    private _loads = new Map<string, Promise<void>>();
    private _teardowns = new Map<string, Promise<void>>();
    private _removals = new Map<string, Promise<void>>();
    private _storageUpdateChannel: Channel;
    private _storageUpdateSubscription: Subscription | null = null;

    // Addon descriptors
    private _addons: StorageAddonDescriptor[];

    constructor(
        addons?: StorageAddonDescriptor[],
    ) {
        this._addons = addons ?? [];

        // Single channel for broadcasting and receiving storage updates
        this._storageUpdateChannel = getStorageUpdatesChannel(LOCAL_STORAGE_UPDATE_CHANNEL);
        this._storageUpdateSubscription = this._storageUpdateChannel.subscribe(
            (message: StorageChannelMessage) => {
                if (message.type === 'repoUpdate') this._onLocalStorageUpdate(message);
            }
        );
    }

    /** Push a non-fatal error to all connected proxies. */
    reportError(message: string) {
        this._storageUpdateChannel.push({ type: 'error', message } as ServiceErrorMessage);
    }

    test() {
        log.info('Test!!!!!!!!!')
        return true
    }

    async loadProject(projectId: string, projectStorageConfig: ProjectStorageConfig, projectUri?: string): Promise<void> {
        if (this._removals.has(projectId)) throw new ProjectStorageLifecycleError(projectId);
        const pending = this._teardowns.get(projectId) ?? this._creations.get(projectId);
        if (pending) {
            await pending;
            return this.loadProject(projectId, projectStorageConfig, projectUri);
        }

        let repoManager = this.repoManagers[projectId];
        if (!repoManager) {
            repoManager = new ProjectStorageManager(projectStorageConfig, this);
            this.repoManagers[projectId] = repoManager;
            this.repoRefCounts[projectId] = 0;
            const manager = repoManager;
            // Register before initialization can yield or invoke addon code.
            const initialization = Promise.resolve().then(async () => {
                try {
                    for (const descriptor of this._addons) {
                        manager.addAddon(descriptor.name, descriptor.create(manager));
                    }
                    await manager.loadProject(projectUri);
                } catch (error) {
                    try {
                        await manager.shutdown();
                    } finally {
                        delete this.repoManagers[projectId];
                        delete this.repoRefCounts[projectId];
                    }
                    throw error;
                } finally {
                    this._loads.delete(projectId);
                }
            });
            this._loads.set(projectId, initialization);
        } else {
            // An existing manager may still be loading; all callers must agree.
            const configsAreTheSame = JSON.stringify(repoManager.config) === JSON.stringify(projectStorageConfig);
            if (!configsAreTheSame) {
                log.error('Repo already loaded with different config', projectId);
                log.error('Loaded config', repoManager.config);
                log.error('Requested config', projectStorageConfig);
                throw new RepositoryConfigMismatchError(`Repository config mismatch for project ${projectId}. Loaded config: ${JSON.stringify(repoManager.config)}, requested config: ${JSON.stringify(projectStorageConfig)}`);
            }
        }

        const initialization = this._loads.get(projectId);
        if (initialization) await initialization;
        if (this._removals.has(projectId)) throw new ProjectStorageLifecycleError(projectId);
        const pendingTeardown = this._teardowns.get(projectId);
        if (pendingTeardown) {
            await pendingTeardown;
            return this.loadProject(projectId, projectStorageConfig, projectUri);
        }
        // Every successful caller owns one reference to the shared manager.
        this.repoRefCounts[projectId]++;
    }

    async unloadProject(projectId: string): Promise<void> {
        /**
         * Decrements reference count and unloads the repo if no more references exist.
         */
        if (!this.repoRefCounts[projectId]) {
            log.warning('Trying to unload a project that is not loaded:', projectId);
            return;
        }

        this.repoRefCounts[projectId]--;

        if (this.repoRefCounts[projectId] <= 0) {
            await this._closeProject(projectId);
        }
    }

    private _closeProject(projectId: string): Promise<void> {
        const existing = this._teardowns.get(projectId);
        if (existing) return existing;
        const closeAdmission = (): Promise<ProjectStorageManager | undefined> => navigator.locks.request(`storage-commit-${projectId}`, () => {
            const manager = this.repoManagers[projectId];
            if (manager) manager.closing = true;
            return manager;
        });
        const initialization = this._loads.get(projectId) ?? this._creations.get(projectId);
        // Reserve the lock immediately for an open project. Initialization,
        // when present, must settle before its adapters can be shut down.
        const admission = initialization
            ? initialization.then(closeAdmission, () => undefined)
            : closeAdmission();
        const teardown = admission.then(async manager => {
            if (!manager) return;
            // Addons may need the commit lock while draining: never hold it here.
            try {
                await manager.shutdown();
            } finally {
                delete this.repoManagers[projectId];
                delete this.repoRefCounts[projectId];
            }
        }).finally(() => { this._teardowns.delete(projectId); });
        this._teardowns.set(projectId, teardown);
        return teardown;
    }

    async createProject(projectId: string, projectStorageConfig: ProjectStorageConfig): Promise<string> {
        if (this._removals.has(projectId) || this._teardowns.has(projectId)) {
            throw new ProjectStorageLifecycleError(projectId);
        }
        if (this.repoManagers[projectId] || this._creations.has(projectId)) {
            throw new Error(`Project ${projectId} already exists or is being created.`);
        }

        const manager = new ProjectStorageManager(projectStorageConfig, this);
        // Reserve creation before adapter work starts. Loads wait; removal waits
        // for cleanup before erasing, even if creation fails partway through.
        const creation = Promise.resolve().then(async () => {
            try {
                await manager.createProject();
            } finally {
                await manager.shutdown();
            }
        }).finally(() => { this._creations.delete(projectId); });
        this._creations.set(projectId, creation);
        await creation;

        return deriveProjectUri(projectId, projectStorageConfig.onDeviceVcsAdapter.name);
    }

    async removeProject(projectId: string, projectStorageConfig: ProjectStorageConfig): Promise<void> {
        const existing = this._removals.get(projectId);
        if (existing) return existing;
        // Ignore references: removal is final, and reserves admission immediately.
        const removal = this._closeProject(projectId).then(async () => {
            for (const descriptor of [...this._addons].reverse()) {
                await descriptor.eraseLocalStorage?.(projectStorageConfig);
            }
            // Erasure does not load repositories, start addons or connect a bridge.
            await eraseProjectLocalStorage(projectStorageConfig);
            log.info(`Removed project ${projectId}`);
        }).finally(() => { this._removals.delete(projectId); });
        this._removals.set(projectId, removal);
        return removal;
    }

    async commit(projectId: string, deltaData: DeltaData, message: string): Promise<CommitOperationResult> {
        const manager = this.repoManagers[projectId];
        return navigator.locks.request(`storage-commit-${projectId}`, async () => {
            return this._executeCommitRequest(projectId, deltaData, message, manager);
        });
    }

    private async _executeCommitRequest(projectId: string, deltaData: DeltaData, message: string, admittedManager?: ProjectStorageManager): Promise<CommitOperationResult> {
        const repoManager = this.repoManagers[projectId];

        if (!repoManager || repoManager !== admittedManager || repoManager.closing || this._loads.has(projectId)) {
            throw new ProjectStorageLifecycleError(projectId);
        }

        const delta = new Delta(deltaData);

        // Commit to in-mem, skipping conflicting changes against the current head.
        const commit = await repoManager.onDeviceRepo.commit(delta, message, {
            skipConflictingChanges: true,
        });
        log.info('Created commit', commit.id)
        repoManager.notifyCommitted(commit.data());

        // Try squash before notifying subscribers, so the broadcast reflects latest graph
        const squashedUpserts = await squashBranchHistory(
            repoManager.onDeviceRepo,
            repoManager.currentBranchName,
            SQUASH_TTL_MS
        ).catch(err => { log.error('[squash] Failed to squash history', err); return []; });

        // Build upserted set conditionally: only augment when squash returned updates
        let upsertedCommits: CommitData[];
        if (squashedUpserts.length > 0) {
            const map = new Map<string, CommitData>();
            for (const c of squashedUpserts) map.set(c.id, c);
            const newCommitData = commit.data();
            if (!map.has(newCommitData.id)) map.set(newCommitData.id, newCommitData);
            upsertedCommits = Array.from(map.values());
        } else {
            upsertedCommits = [commit.data()];
        }

        // Notify subscribers (graph reflects any squash because we fetch after applying)
        const commitGraph = await this.repoManagers[projectId].onDeviceRepo.getCommitGraph()
        this.broadcastLocalUpdate({
            type: 'repoUpdate',
            projectId: projectId,
            storageServiceId: this.id,
            update: {
                commitGraph: commitGraph.data(),
                upsertedCommits
            }
        });

        // Push committed delta to domain store (filesystem bridge).
        // PSM's syncDeltaToDomainStore is a no-op when no domain store is configured.
        // For commits originating from external FS changes (pulled by PSM's poll loop),
        // this writes back the same data — the backend PFM detects no diff and it's a no-op.
        await repoManager.syncDeltaToDomainStore(commit.data().delta_data);

        return {
            type: 'commit',
            commit: commit.data(),
        };
    }


    broadcastLocalUpdate(update: LocalStorageUpdateMessage) {
        log.info('Broadcasting local storage update', update);
        this._storageUpdateChannel.push(update);
    }

    _onLocalStorageUpdate(updateMessage: LocalStorageUpdateMessage) {
        log.info('Received local storage update', updateMessage)

        // (Edge case) If there's more than one local storage service
        // (e.g. hard refresh and no service worker) - react on updates by pulling
        // Should be done only for updates that are not from this service
        if (updateMessage.storageServiceId !== this.id && updateMessage.projectId in this.repoManagers) {
            let repoManager = this.repoManagers[updateMessage.projectId];
            repoManager.onDeviceRepo.pull(repoManager.onDeviceRepo).catch((error) => {
                log.error('Error pulling local storage update', error)
            });
        }
    }

    async getCommitGraph(projectId: string): Promise<CommitGraphData> {
        let repoManager = this.repoManagers[projectId];
        if (!repoManager) {
            throw new Error("Repo not loaded");
        }
        const graph = await repoManager.onDeviceRepo.getCommitGraph();
        return graph.data();
    }

    async getCommits(projectId: string, commitIds: string[]): Promise<CommitData[]> {
        let repoManager = this.repoManagers[projectId];
        if (!repoManager) {
            throw new Error("Repo not loaded");
        }
        const commits = await repoManager.onDeviceRepo.getCommits(commitIds);
        return commits.map(commit => commit.data());
    }

    // File operations
    async addFile(projectId: string, blob: Blob, path: string): Promise<AddFileResult> {
        let repoManager = this.repoManagers[projectId];
        if (!repoManager) {
            throw new Error("Repo not loaded");
        }

        // Generate a unique path using the utility function and check against the in-memory repository
        const uniquePath = generateUniquePathWithSuffix(path, (checkPath: string) => {
            // Check if any entity with this path exists in the in-memory repository
            return !!repoManager.onDeviceRepo.headStore.findOne({ path: checkPath });
        });

        log.info(`Adding file to project ${projectId} with unique path: ${uniquePath}`);
        const result = await repoManager.fileStore.addFile(blob, uniquePath);

        return result;
    }

    async getFile(projectId: string, path: string): Promise<Blob> {
        let repoManager = this.repoManagers[projectId];
        if (!repoManager) {
            throw new Error("Repo not loaded");
        }
        return repoManager.fileStore.getFile(path);
    }

    async removeFile(projectId: string, path: string): Promise<void> {
        let repoManager = this.repoManagers[projectId];
        if (!repoManager) {
            throw new Error("Repo not loaded");
        }

        await repoManager.fileStore.removeFile(path);
    }

    async sendToAddon(projectId: string, addonName: string, message: unknown): Promise<unknown> {
        const repoManager = this.repoManagers[projectId];
        if (!repoManager) {
            throw new Error("Repo not loaded");
        }
        return repoManager.sendToAddon(addonName, message);
    }

    disconnect() {
        this._storageUpdateSubscription?.unsubscribe();
    }

}
