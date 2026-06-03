import * as Comlink from 'comlink';
import { getLogger } from '../../logging';
import { StorageServiceInterface } from './StorageService';
import { createId } from '../../util/base';

const log = getLogger('shared-worker-utils');

declare const self: SharedWorkerGlobalScope;

type LoggedStorageServiceBridge = {
    [K in keyof StorageServiceInterface]: StorageServiceInterface[K];
};

function createLoggedStorageServiceBridge(storageService: StorageServiceInterface): LoggedStorageServiceBridge {
    return {
        loadProject: async (projectId, repoManagerConfig, projectUri) => {
            return logWorkerOperation('loadProject', `projectId=${projectId}`, () => storageService.loadProject(projectId, repoManagerConfig, projectUri));
        },
        createProject: async (projectId, projectStorageConfig) => {
            return logWorkerOperation('createProject', `projectId=${projectId}`, () => storageService.createProject(projectId, projectStorageConfig));
        },
        unloadProject: async (projectId) => {
            return logWorkerOperation('unloadProject', `projectId=${projectId}`, () => storageService.unloadProject(projectId));
        },
        removeProject: async (projectId, projectStorageConfig) => {
            return logWorkerOperation('removeProject', `projectId=${projectId}`, () => storageService.removeProject(projectId, projectStorageConfig));
        },
        getCommitGraph: async (projectId) => {
            return logWorkerOperation('getCommitGraph', `projectId=${projectId}`, () => storageService.getCommitGraph(projectId));
        },
        getCommits: async (projectId, commitIds) => {
            return logWorkerOperation('getCommits', `projectId=${projectId} commitCount=${commitIds.length}`, () => storageService.getCommits(projectId, commitIds));
        },
        commit: async (projectId, deltaData, message) => {
            return logWorkerOperation('commit', `projectId=${projectId}`, () => storageService.commit(projectId, deltaData, message));
        },
        addFile: async (projectId, blob, path) => {
            return logWorkerOperation('addFile', `projectId=${projectId} path=${path} size=${blob.size}`, () => storageService.addFile(projectId, blob, path));
        },
        getFile: async (projectId, path) => {
            return logWorkerOperation('getFile', `projectId=${projectId} path=${path}`, () => storageService.getFile(projectId, path));
        },
        removeFile: async (projectId, path) => {
            return logWorkerOperation('removeFile', `projectId=${projectId} path=${path}`, () => storageService.removeFile(projectId, path));
        },
        test: () => {
            return storageService.test();
        },
        disconnect: () => {
            storageService.disconnect();
        }
    };
}

async function logWorkerOperation<T>(operationName: string, detail: string, work: () => Promise<T>): Promise<T> {
    const operationId = createId(6);
    const startedAt = Date.now();
    log.info(`[op:${operationId}] Received ${operationName}${detail ? ` (${detail})` : ''}`);
    try {
        const result = await work();
        log.info(`[op:${operationId}] Completed ${operationName} in ${Date.now() - startedAt}ms`);
        return result;
    } catch (error) {
        log.error(`[op:${operationId}] Failed ${operationName} after ${Date.now() - startedAt}ms`, error);
        throw error;
    }
}

export function setupSharedWorker(storageService: StorageServiceInterface) {
    const loggedStorageService = createLoggedStorageServiceBridge(storageService);

    self.addEventListener('connect', (event: MessageEvent) => {
        const port = (event as MessageEvent).ports[0];
        if (port) {
            log.info('SharedWorker: New tab connected, exposing Comlink on port');
            Comlink.expose(loggedStorageService, port);
            port.start();
        } else {
            log.error('SharedWorker: No port received in connect event');
        }
    });

    log.info('SharedWorker setup complete, waiting for connections');
}
