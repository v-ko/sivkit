import * as Comlink from 'comlink';
import { ProjectStorageConfig, StorageAddon, ProjectStorageManager } from './ProjectStorageManager';
import { DeltaData } from '../../model/Delta';
import { RepoUpdateData } from '../repository/Repository';
import { AddFileResult } from '../file-store/FileStoreAdapter';
import { getLogger } from '../../logging';
import { Subscription } from '../../registries/Channel';
import { CommitData } from '../version-control/Commit';
import { CommitGraphData } from '../version-control/CommitGraph';
import {
    StorageServiceInterface,
    StorageService,
    StorageChannelMessage,
    getStorageUpdatesChannel,
    LOCAL_STORAGE_UPDATE_CHANNEL,
    CommitOperationResult,
} from './StorageService';

let log = getLogger('StorageServiceProxy');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type StorageConnectionPhase =
    | 'uninitialized'
    | 'connecting'
    | 'ready'
    | 'disconnected'
    | 'fatal';

export type StorageProjectPhase =
    | 'detached'
    | 'attaching'
    | 'attached'
    | 'detaching';

export interface StorageProxyError {
    message: string;
    timestamp: number;
}

export interface StorageProxyState {
    connectionPhase: StorageConnectionPhase;
    projectPhase: StorageProjectPhase;
    activeProjectId: string | null;
    lastError: StorageProxyError | null;
    errors: StorageProxyError[];
    degraded: boolean;
    degradedReason: string | null;
}

export function createInitialStorageProxyState(): StorageProxyState {
    return {
        connectionPhase: 'uninitialized',
        projectPhase: 'detached',
        activeProjectId: null,
        lastError: null,
        errors: [],
        degraded: false,
        degradedReason: null,
    };
}

export type RepoUpdateNotifiedSignature = (update: RepoUpdateData) => void;

// ---------------------------------------------------------------------------
// Proxy
// ---------------------------------------------------------------------------

const CONNECT_TIMEOUT_MS = 10_000;

export class StorageServiceProxy {
    private _service: Comlink.Remote<StorageServiceInterface> | StorageServiceInterface | null = null;
    private _sharedWorker: SharedWorker | null = null;
    private _channelSubscription: Subscription;
    private _projectUpdateCallbacks: Map<string, RepoUpdateNotifiedSignature> = new Map();
    private _stateChangeHandler: ((state: StorageProxyState) => void) | null = null;

    state: StorageProxyState = createInitialStorageProxyState();

    constructor() {
        const channel = getStorageUpdatesChannel(LOCAL_STORAGE_UPDATE_CHANNEL);
        this._channelSubscription = channel.subscribe(
            (msg: StorageChannelMessage) => this._handleChannelMessage(msg),
        );
    }

    // ----- State management -----

    setStateChangeHandler(handler: ((state: StorageProxyState) => void) | null) {
        this._stateChangeHandler = handler;
        this._emitState();
    }

    private _emitState() {
        if (this._stateChangeHandler) {
            this._stateChangeHandler({
                ...this.state,
                lastError: this.state.lastError ? { ...this.state.lastError } : null,
                errors: [...this.state.errors],
            });
        }
    }

    private _setState(patch: Partial<StorageProxyState>) {
        const next = { ...this.state, ...patch };
        if (JSON.stringify(next) === JSON.stringify(this.state)) return;
        this.state = next;
        this._emitState();
    }

    private _setError(message: string, connectionPhase?: StorageConnectionPhase) {
        const error: StorageProxyError = { message, timestamp: Date.now() };
        this._setState({
            connectionPhase: connectionPhase ?? this.state.connectionPhase,
            lastError: error,
            errors: [...this.state.errors, error],
        });
    }

    setDegraded(reason: string) {
        log.warning('Storage service running in degraded mode:', reason);
        this._setState({ degraded: true, degradedReason: reason });
    }

    /** Record a non-fatal error without changing connection phase. */
    reportError(message: string) {
        log.error('Storage error reported:', message);
        const error: StorageProxyError = { message, timestamp: Date.now() };
        this._setState({
            lastError: error,
            errors: [...this.state.errors, error],
        });
    }

    // ----- Service accessor -----

    private get service(): Comlink.Remote<StorageServiceInterface> | StorageServiceInterface {
        if (!this._service) {
            throw new Error('Storage service not set up. Call setupInMainThread or setupInSharedWorker first.');
        }
        return this._service;
    }

    // ----- Channel handling -----

    private _handleChannelMessage(msg: StorageChannelMessage) {
        switch (msg.type) {
            case 'repoUpdate': {
                log.info('Received local storage update', msg);
                const cb = this._projectUpdateCallbacks.get(msg.projectId);
                if (cb) cb(msg.update);
                break;
            }
            case 'error':
                this.reportError(msg.message);
                break;
        }
    }

    // ----- Setup -----

    setupInMainThread(
        addons?: { name: string; create: (psm: ProjectStorageManager) => StorageAddon }[],
    ) {
        log.info('Setting up storage service in main thread');
        this._service = new StorageService(addons);
        this._setState({ connectionPhase: 'ready' });
    }

    async setupInSharedWorker(worker: SharedWorker) {
        log.info('Setting up storage service via SharedWorker');
        this._setState({ connectionPhase: 'connecting' });

        this._sharedWorker = worker;
        const service = Comlink.wrap<StorageServiceInterface>(worker.port);

        // Connection test with timeout
        try {
            const result = await Promise.race([
                Promise.resolve(service.test()),
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error(`SharedWorker connection timed out after ${CONNECT_TIMEOUT_MS}ms`)), CONNECT_TIMEOUT_MS),
                ),
            ]);
            if (!result) throw new Error('SharedWorker test() returned falsy');
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this._setError(msg, 'fatal');
            throw e;
        }

        this._service = service;
        this._setState({ connectionPhase: 'ready' });

        worker.onerror = (event) => {
            log.error('SharedWorker crashed', event.message);
            this._setError('SharedWorker crashed: ' + (event.message || 'unknown error'), 'disconnected');
        };

        log.info('SharedWorker storage service ready');
    }

    // ----- Proxy methods -----

    async loadProject(
        projectId: string,
        projectStorageConfig: ProjectStorageConfig,
        commitNotify?: RepoUpdateNotifiedSignature,
        projectUri?: string,
    ): Promise<void> {
        log.info('Loading project', projectId);
        this._setState({ activeProjectId: projectId, projectPhase: 'attaching' });
        try {
            await this.service.loadProject(projectId, projectStorageConfig, projectUri);
            if (commitNotify) this._projectUpdateCallbacks.set(projectId, commitNotify);
            this._setState({ projectPhase: 'attached' });
        } catch (error) {
            this._projectUpdateCallbacks.delete(projectId);
            this._setState({ activeProjectId: null, projectPhase: 'detached' });
            throw error;
        }
    }

    async unloadProject(projectId: string): Promise<void> {
        const isActive = this.state.activeProjectId === projectId;
        if (isActive) this._setState({ projectPhase: 'detaching' });
        try {
            await this.service.unloadProject(projectId);
            log.info('Unloaded project', projectId);
        } finally {
            this._projectUpdateCallbacks.delete(projectId);
            if (isActive) {
                this._setState({ activeProjectId: null, projectPhase: 'detached' });
            }
        }
    }

    async createProject(projectId: string, config: ProjectStorageConfig): Promise<string> {
        return this.service.createProject(projectId, config);
    }

    async removeProject(projectId: string, config: ProjectStorageConfig): Promise<void> {
        return this.service.removeProject(projectId, config);
    }

    async commit(projectId: string, deltaData: DeltaData, message: string): Promise<CommitOperationResult> {
        return this.service.commit(projectId, deltaData, message);
    }

    getCommitGraph(projectId: string): Promise<CommitGraphData> {
        return this.service.getCommitGraph(projectId);
    }

    getCommits(projectId: string, commitIds: string[]): Promise<CommitData[]> {
        return this.service.getCommits(projectId, commitIds);
    }

    async addFile(projectId: string, blob: Blob, path: string): Promise<AddFileResult> {
        return this.service.addFile(projectId, blob, path);
    }

    async getFile(projectId: string, path: string): Promise<Blob> {
        return this.service.getFile(projectId, path);
    }

    async removeFile(projectId: string, path: string): Promise<void> {
        return this.service.removeFile(projectId, path);
    }

    async test() {
        return this.service.test();
    }

    async restartStorageWorker() {
        log.info('Restarting storage worker (page reload)...');
        window.location.reload();
    }

    /** Testing only. Simulates a SharedWorker crash by severing the connection. */
    simulateWorkerCrash() {
        log.warning('Simulating SharedWorker crash');
        this._service = null;
        this._setError('Simulated SharedWorker crash', 'disconnected');
    }

    /** Testing only. Do not use in production code. */
    get sharedWorker(): SharedWorker | null {
        return this._sharedWorker;
    }

    disconnect() {
        this._channelSubscription?.unsubscribe();
        if (this._service && !(this._service as any)[Comlink.releaseProxy]) {
            // Main-thread instance — call disconnect directly
            (this._service as StorageServiceInterface).disconnect();
        }
    }
}
