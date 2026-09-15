import { getVcsAdapter, Repository, RepositoryIntegrityError, MissingBranchError, CorruptVcsStoreError, VcsAdapterConfig, verifyRepositoryIntegrity } from "../repository/Repository";
import { FileStoreAdapter } from "../file-store/FileStoreAdapter";
import { InMemoryFileStoreAdapter } from "../file-store/InMemoryFileStoreAdapter";
import { CacheFileStoreAdapter } from "../file-store/CacheFileStoreAdapter";
import { RestApiFileStoreAdapter } from "../file-store/RestApiFileStoreAdapter";
import { getLogger } from "../../logging";
import { RestApiAuthConfig } from "../rest-api/Auth";
import type { StorageService } from "./StorageService";
import type { DomainStoreAdapter, DomainStoreConfig } from "../domain-store-adapter/DomainStoreAdapter";
import { RestApiDomainStoreAdapter } from "../domain-store-adapter/RestApiDomainStoreAdapter";
import { loadFromDict } from "../../model/Entity";
import { Delta, DeltaData } from "../../model/Delta";
import { Change } from "../../model/Change";

let log = getLogger('ProjectStorageManager');

export type { DomainStoreAdapter } from "../domain-store-adapter/DomainStoreAdapter";
export type { DomainStoreConfig } from "../domain-store-adapter/DomainStoreAdapter";

/**
 * Extension point for app-specific storage concerns (e.g. desktop bridge
 * lifecycle, FS-change polling, reference enrichment).
 *
 * Addons are created by factories registered on StorageService and
 * attached to the PSM before loadProject runs.
 */
export interface StorageAddon {
    /** Called early, before adapter queries / VCS hydration. Use for bridge setup. */
    onProjectLoading?(): Promise<void>;
    /** Called after VCS is open and headStore is populated. Use for poll loop start. */
    onProjectLoaded(): Promise<void>;
    /** Called at the start of unload. Use for poll loop stop and bridge teardown. */
    onProjectUnloading(): Promise<void>;
}

export interface ProjectStorageConfig {
    projectId: string;
    deviceBranchName: string;
    onDeviceVcsAdapter: VcsAdapterConfig;  // IndexedDB, RestApi, Cloud (for thin clients), InMemory for testing
    onDeviceFileStore: FileStoreConfig;  // CacheAPI, RestApi, Cloud (for thin clients), InMemory for testing
    domainStore?: DomainStoreConfig;  // External domain store config (e.g. desktop backend filesystem bridge)
}

export interface FileStoreConfig {
    name: FileStoreAdapterNames;
    args: FileStoreAdapterArgs;
}

export interface FileStoreAdapterArgs {
    userId?: string;
    projectId: string;
    baseUrl?: string;
    auth?: RestApiAuthConfig;
}

export type FileStoreAdapterNames = "InMemory" | "CacheAPI" | "RestApi";

async function initFileStore(config: FileStoreConfig): Promise<FileStoreAdapter> {
    let fileStore: FileStoreAdapter;

    switch (config.name) {
        case "InMemory": {
            let inMemFileStore = new InMemoryFileStoreAdapter();
            fileStore = inMemFileStore
            break;
        }
        case "CacheAPI": {
            let cacheFileStore = new CacheFileStoreAdapter(config.args.projectId);
            await cacheFileStore.init();
            log.info('Initialized CacheFileStoreAdapter for project', config.args.projectId);
            fileStore = cacheFileStore
            break;
        }
        case "RestApi": {
            const { userId, projectId, baseUrl, auth } = config.args;
            if (!userId) {
                throw new Error("RestApi file store requires args.userId in config");
            }
            if (!baseUrl) {
                throw new Error("RestApi file store requires args.baseUrl in config");
            }
            if (!auth) {
                throw new Error("RestApi file store requires args.auth in config");
            }
            fileStore = new RestApiFileStoreAdapter(userId, projectId, baseUrl, auth);
            break;
        }
        default: {
            throw new Error(`Unknown file store name: ${config.name}`)
        }
    }

    return fileStore
}


function initDomainStoreAdapter(config: DomainStoreConfig): DomainStoreAdapter {
    switch (config.name) {
        case "RestApi": {
            const { projectId, baseUrl, auth } = config.args;
            return new RestApiDomainStoreAdapter(projectId, baseUrl, auth);
        }
        default:
            throw new Error(`Unknown domain store adapter type: ${config.name}`);
    }
}


export class ProjectStorageManager {
    /**
     * A class to manage the storage adapters and sync graph operations for a
     * repository (of a project).
     *
     * Each project needs storage. A client will always have a local storage
     * adapter to keep offline state (indexdb or device (desktop/mobile)).
     *
     * To allow for inter-device-sync or collab/sharing we apply new commits from
     * each device to their own branch (like in git). The resulting graph is the
     * "sync graph" (since it's used for state synchronization).
     * The synchronization process consists of communicating sync graph changes -
     * e.g. through yjs/webrtc or other means we convey changes in a CRDT-like
     * manner, where the order of update arrival does not matter.
     * The other operations on the graph (squashing, merging) are applied by
     * each client to their own branch, which allows for the above properties of
     * sync graph updates (arrival order irrelevance, ..?). Merge-conflicts
     * (where two clients commit at the same time on the same data) are resolved
     * deterministically by seniority. I.e. the junior node always adapts first,
     * and the senior node adopts only commits made on top of its own branch head.
     */
    private _config: ProjectStorageConfig;
    _onDeviceRepo: Repository | null = null;
    private _localFileStore: FileStoreAdapter | null = null;
    private _parentStorageService: StorageService | null = null;
    private _domainStoreAdapter: DomainStoreAdapter | null = null;
    private _addons: StorageAddon[] = [];
    private _projectUri: string | undefined = undefined;

    constructor(config: ProjectStorageConfig, parentStorageService: StorageService | null = null) {
        this._config = config
        this._parentStorageService = parentStorageService;

        // Assert that the adapter local branches and the device branch are the same
        if (this._config.deviceBranchName !== this._config.onDeviceVcsAdapter.args.localBranchName) {
            throw new Error("Device branch name and on-device repo local branch name must match")
        }

        if (this._config.domainStore) {
            this._domainStoreAdapter = initDomainStoreAdapter(this._config.domainStore);
        }
    }
    get onDeviceRepo() {
        if (!this._onDeviceRepo) {
            throw new Error("Local storage repo not set. Have you called init?")
        }
        return this._onDeviceRepo
    }
    get fileStore() {
        if (!this._localFileStore) {
            throw new Error("File store not set. Have you called init?")
        }
        return this._localFileStore
    }
    get config(): ProjectStorageConfig {
        return this._config
    }
    get currentBranchName() {
        return this.config.deviceBranchName
    }
    get parentStorageService(): StorageService | null {
        return this._parentStorageService;
    }
    get projectUri(): string | undefined {
        return this._projectUri;
    }

    addAddon(addon: StorageAddon) {
        this._addons.push(addon);
    }

    get domainStoreAdapter(): DomainStoreAdapter | null {
        return this._domainStoreAdapter;
    }

    // ---- Project lifecycle ----

    async loadProject(projectUri?: string) {
        this._projectUri = projectUri;
        const ds = this._domainStoreAdapter;

        // 1. Early addon hook (e.g. bridge setup)
        for (const addon of this._addons) {
            if (addon.onProjectLoading) {
                await addon.onProjectLoading();
            }
        }

        // 2. Open VCS (with domain store entities if available)
        let headStoreData;
        if (ds) {
            const entityDicts = await ds.find();
            headStoreData = entityDicts.map(d => loadFromDict(d));
            log.info(`Fetched ${headStoreData.length} entities from domain store`);
        }

        try {
            this._onDeviceRepo = await Repository.open(this.config.onDeviceVcsAdapter, true, headStoreData)
        } catch (e) {
            if (e instanceof MissingBranchError && headStoreData) {
                log.info(`VCS store empty, creating repository from ${headStoreData.length} domain store entities`);
                this._onDeviceRepo = await Repository.create(this.config.onDeviceVcsAdapter, true);
                if (headStoreData.length > 0) {
                    const initialDelta = Delta.fromChanges(headStoreData.map(e => Change.create(e)));
                    await this._onDeviceRepo.commit(initialDelta, 'Initial commit from domain store');
                }
            } else if (e instanceof CorruptVcsStoreError) {
                // Version history is physically damaged and cannot be recovered in
                // place (e.g. after an unclean shutdown). Discard it and rebuild.
                log.error('VCS store corrupt; discarding and rebuilding local version history', e);
                const adapter = await getVcsAdapter(this.config.onDeviceVcsAdapter);
                await adapter.eraseStorage();
                this._onDeviceRepo = await Repository.create(this.config.onDeviceVcsAdapter, true);
                if (headStoreData && headStoreData.length > 0) {
                    // HEAD survives outside the VCS (domain store): rebuild is lossless.
                    const initialDelta = Delta.fromChanges(headStoreData.map(e => Change.create(e)));
                    await this._onDeviceRepo.commit(initialDelta, 'Rebuild after VCS corruption');
                    this._parentStorageService?.reportError(
                        'The local version history was damaged (likely due to an unclean shutdown) and has been rebuilt from the current project data. No data was lost, but commit history is gone.'
                    );
                } else {
                    // No HEAD source available (e.g. local-only web): the store had to
                    // be reset. Unsynced changes may be lost.
                    this._parentStorageService?.reportError(
                        'The local version history was damaged (likely due to an unclean shutdown) and could not be recovered. The project has been reset. Unsynced changes may have been lost.'
                    );
                }
            } else {
                if (e instanceof RepositoryIntegrityError) {
                    let storageAdapter = await getVcsAdapter(this.config.onDeviceVcsAdapter);
                    log.error('Attempting repository integrity verification after load failure', e);
                    await verifyRepositoryIntegrity(storageAdapter, this.config.deviceBranchName);
                }
                throw e;
            }
        }

        // 3. If domain store exists: verify hash integrity
        if (ds) {
            const commitGraph = await this._onDeviceRepo.getCommitGraph();
            const headCommit = commitGraph.headCommit(this.config.deviceBranchName);
            if (headCommit) {
                const diskHash = this._onDeviceRepo.hashTree.rootHash();
                const vcsHash = headCommit.snapshotHash;
                if (diskHash !== vcsHash) {
                    log.error(`Integrity check failed: filesystem hash (${diskHash}) does not match VCS head hash (${vcsHash}). Discarding VCS and recreating.`);
                    this._onDeviceRepo.close();
                    const adapter = await getVcsAdapter(this.config.onDeviceVcsAdapter);
                    await adapter.eraseStorage();

                    this._onDeviceRepo = await Repository.create(this.config.onDeviceVcsAdapter, true);
                    if (headStoreData!.length > 0) {
                        const initialDelta = Delta.fromChanges(headStoreData!.map(e => Change.create(e)));
                        await this._onDeviceRepo.commit(initialDelta, 'Re-seed after integrity failure');
                    }
                    this._parentStorageService?.reportError(
                        'VCS integrity check failed. The version history was discarded and recreated from the current data. No data was lost, but commit history is gone.'
                    );
                }
            }

        }

        this._localFileStore = await initFileStore(this.config.onDeviceFileStore)

        // Notify addons after project is fully loaded
        for (const addon of this._addons) {
            await addon.onProjectLoaded();
        }
    }

    async createProject(): Promise<void> {
        if (this._domainStoreAdapter) {
            throw new Error("Desktop project creation is not implemented yet. Folder selection and project initialization still need to be added.");
        }
        this._onDeviceRepo = await Repository.create(this.config.onDeviceVcsAdapter, true);
        this._localFileStore = await initFileStore(this.config.onDeviceFileStore);
    }

    async unloadProject(): Promise<void> {
        log.info('Closing project storage manager')
        for (const addon of this._addons) {
            await addon.onProjectUnloading();
        }
        if (this._onDeviceRepo) {
            this._onDeviceRepo.close()
        }
        this._onDeviceRepo = null;
        this._localFileStore = null;
    }

    async shutdown() {
        await this.unloadProject();
    }

    // ---- Domain store sync ----

    /** Push a user-initiated delta to the domain store (filesystem). */
    async syncDeltaToDomainStore(deltaData: DeltaData): Promise<void> {
        if (!this._domainStoreAdapter) return;
        await this._domainStoreAdapter.applyDelta(deltaData);
    }

    async eraseLocalStorage() {
        if (this._onDeviceRepo) {
            await this._onDeviceRepo.eraseStorage();
        } else {
            log.warning('VCS storage not initialized. Nothing to erase.');
        }
        if (this._localFileStore) {
            await this._localFileStore.eraseStorage();
        } else {
            log.warning('File store not initialized. Nothing to erase.');
        }
    }
}
