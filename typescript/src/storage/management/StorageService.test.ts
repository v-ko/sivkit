import { Change } from "sivkit/model/Change";
import { Delta } from "sivkit/model/Delta";
import { ProjectStorageConfig, ProjectStorageManager } from "sivkit/storage/management/ProjectStorageManager";
import { StorageService, StorageAddonDescriptor } from './StorageService';
import { StorageServiceProxy, StorageProxyState } from "sivkit/storage/management/StorageServiceProxy";
import { clearInMemoryAdapterInstances, getVcsAdapter, Repository, RepoUpdateData, VcsAdapterConfig } from "sivkit/storage/repository/Repository";
import { DummyNote, DummyPage } from "sivkit/storage/test-utils";
import { createId } from "sivkit/util/base";
import { clearChannels } from "sivkit/registries/Channel";
import { InMemoryStore } from "../domain-store/InMemoryStore";
import { buildHashTree } from "../version-control/HashTree";
import { dumpToDict } from "../../model/Entity";

// Polyfill navigator.locks for Node test environment (FIFO, non-reentrant)
{
    const lockQueues = new Map<string, Promise<void>>();
    const locksImpl = {
        request: async (name: string, callback: () => Promise<any>) => {
            const prev = lockQueues.get(name) ?? Promise.resolve();
            let releaseLock!: () => void;
            const next = new Promise<void>(r => { releaseLock = r; });
            lockQueues.set(name, next);
            await prev;
            try {
                return await callback();
            } finally {
                releaseLock();
            }
        },
    };
    if (typeof globalThis.navigator === 'undefined') {
        (globalThis as any).navigator = { locks: locksImpl };
    } else {
        Object.defineProperty(globalThis.navigator, 'locks', { value: locksImpl, configurable: true });
    }
}


const INMEM_PROJECT_STORAGE_CONFIG: VcsAdapterConfig = {
    name: 'InMemorySingletonForTesting',
    args: {
        localBranchName: 'dev1',
        projectId: 'test-project-id',
    }
}

function signal() {
    let resolve!: () => void;
    const promise = new Promise<void>(r => { resolve = r; });
    return { promise, resolve };
}


// Arm the callback before committing; await both delivery and the commit result.
async function commitAndObserve(
    service: StorageServiceProxy,
    projectId: string,
    onUpdate: jest.Mock<void, [RepoUpdateData]>,
    delta: Delta,
    message: string,
) {
    const delivered = new Promise<RepoUpdateData>(resolve => onUpdate.mockImplementation(resolve));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const [result, update] = await Promise.race([
            Promise.all([service.commit(projectId, delta.data, message), delivered]),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('Commit or update delivery timed out')), 2000);
            }),
        ]);
        return { result, update };
    } finally {
        clearTimeout(timer);
        onUpdate.mockImplementation(() => {});
    }
}



describe("StorageService base functionality", () => {
    let storageService: StorageServiceProxy;
    let projectId: string;
    let projectStorageConfig: ProjectStorageConfig;
    let proxies: StorageServiceProxy[];
    let services: StorageService[];

    function createProxy() {
        const proxy = new StorageServiceProxy();
        proxies.push(proxy);
        return proxy;
    }

    function createService(addons: StorageAddonDescriptor[]) {
        const service = new StorageService(addons);
        services.push(service);
        return service;
    }

    beforeEach(async () => {
        proxies = [];
        services = [];
        storageService = createProxy();
        storageService.setupInMainThread();
        projectId = 'test-project-id';

        projectStorageConfig = {
            projectId,
            deviceBranchName: 'dev1',
            onDeviceVcsAdapter: INMEM_PROJECT_STORAGE_CONFIG,
            onDeviceFileStore: {
                name: "InMemory",
                args: { projectId }
            }
        };
    });

    afterEach(async () => {
        for (const proxy of proxies) proxy.disconnect();
        for (const service of services) service.disconnect();
        clearChannels();
        clearInMemoryAdapterInstances();
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    test("setStateChangeHandler emits initial and updated snapshots", () => {
        const observedStates: StorageProxyState[] = [];
        const observedService = createProxy();

        observedService.setStateChangeHandler((nextState) => {
            observedStates.push(nextState);
        });
        observedService.setupInMainThread();

        expect(observedStates.length).toBeGreaterThanOrEqual(2);
        expect(observedStates[0].connectionPhase).toBe('uninitialized');
        expect(observedStates[observedStates.length - 1].connectionPhase).toBe('ready');

    });

    test("loadProject updates project phase on success and resets it on failure", async () => {
        (storageService as any)._service = {
            loadProject: jest.fn(async () => { }),
            disconnect: jest.fn(),
        };

        await storageService.loadProject(projectId, projectStorageConfig, () => { });
        expect(storageService.state.projectPhase).toBe('attached');
        expect(storageService.state.activeProjectId).toBe(projectId);

        (storageService as any)._service = {
            loadProject: jest.fn(async () => {
                throw new Error('load failed');
            }),
            disconnect: jest.fn(),
        };

        await expect(storageService.loadProject('missing-project', projectStorageConfig, () => { })).rejects.toThrow('load failed');
        expect(storageService.state.projectPhase).toBe('detached');
        expect(storageService.state.activeProjectId).toBeNull();
    });

    test("commit returns a rejected promise when the storage request fails", async () => {
        const commitFailure = new Error('commit failed');
        (storageService as any)._service = {
            commit: jest.fn(async () => {
                throw commitFailure;
            }),
            disconnect: jest.fn(),
        };

        const delta = Delta.fromChanges([Change.create(new DummyPage({ id: createId(), parent_id: '', name: "Test Page" }))]);
        await expect(storageService.commit(projectId, delta.data, "Test commit")).rejects.toThrow('commit failed');
    });

    test("Project load and unload", async () => {
        // Create
        await storageService.createProject(projectId, projectStorageConfig);

        // Load
        await storageService.loadProject(projectId, projectStorageConfig, () => { });
        let commitGraph = await storageService.getCommitGraph(projectId);
        expect(commitGraph).toBeDefined();

        // Unload
        await storageService.unloadProject(projectId);
        await expect(storageService.getCommitGraph(projectId)).rejects.toThrow();

        // Second unload is a no-op (idempotent)
        await storageService.unloadProject(projectId);

        // Reload and delete to avoid errors on the next test
        await storageService.loadProject(projectId, projectStorageConfig, () => { });
        await storageService.removeProject(projectId, projectStorageConfig);
    });

    test("Project create and delete", async () => {
        // Create
        await storageService.createProject(projectId, projectStorageConfig);

        // Try to create again, expect failure for duplicate id
        await expect(storageService.createProject(projectId, projectStorageConfig)).rejects.toThrow();

        // Removal erases without loading the project or constructing addons.
        await storageService.removeProject(projectId, projectStorageConfig);

        // Try to load deleted project
        await expect(storageService.loadProject(projectId, projectStorageConfig, () => { })).rejects.toThrow();
    });

    test("Commit to project", async () => {
        // Create project
        await storageService.createProject(projectId, projectStorageConfig);

        const onUpdate = jest.fn<void, [RepoUpdateData]>();
        await storageService.loadProject(projectId, projectStorageConfig, onUpdate);

        const page = new DummyPage({ id: createId(), parent_id: '', name: "Test Page" });
        const note = new DummyNote({ id: createId(), parent_id: page.id, testProp: "Test Note" });
        const delta = Delta.fromChanges([Change.create(page), Change.create(note)]);

        const { result, update } = await commitAndObserve(storageService, projectId, onUpdate, delta, "Test commit");
        expect(result).toMatchObject({
            type: 'commit',
            commit: expect.objectContaining({
                message: 'Test commit',
                delta_data: delta.data,
            }),
        });

        expect(update.upsertedCommits).toEqual([result.commit]);
        expect(update.commitGraph.branches).toEqual([
            { name: 'dev1', head_commit_id: result.commit.id },
        ]);
    });

    test("addons get each commit and messages by name", async () => {
        const committed: string[] = [];
        const addonService = createProxy();
        addonService.setupInMainThread([
            {
                name: 'failing', create: () => ({
                    onProjectLoaded: async () => { },
                    onProjectUnloading: async () => { },
                    onCommitted: () => { throw new Error('addon bug'); },
                })
            },
            {
                name: 'recorder', create: () => ({
                    onProjectLoaded: async () => { },
                    onProjectUnloading: async () => { },
                    onCommitted: (commit) => { committed.push(commit.message); },
                    onMessage: async (message) => ({ echo: message }),
                })
            },
        ]);
        await addonService.createProject(projectId, projectStorageConfig);
        await addonService.loadProject(projectId, projectStorageConfig, () => { });

        const page = new DummyPage({ id: createId(), parent_id: '', name: "P" });
        await addonService.commit(projectId, Delta.fromChanges([Change.create(page)]).data, "c0");
        expect(committed).toEqual(["c0"]);

        await expect(addonService.sendToAddon(projectId, 'recorder', 'hi')).resolves.toEqual({ echo: 'hi' });
        await expect(addonService.sendToAddon(projectId, 'failing', 'hi')).rejects.toThrow();
    });

    test('Creation and shared loading validate admission and count references', async () => {
        const creating = signal(), finishCreation = signal();
        const loading = signal(), finishLoading = signal();
        const original = ProjectStorageManager.prototype.createProject;
        jest.spyOn(ProjectStorageManager.prototype, 'createProject').mockImplementationOnce(async function (this: ProjectStorageManager) {
            creating.resolve();
            await finishCreation.promise;
            await original.call(this);
        });
        const unloading = jest.fn(async () => {});
        const create = jest.fn(() => ({
            onProjectLoaded: async () => { loading.resolve(); await finishLoading.promise; },
            onProjectUnloading: unloading,
        }));
        const service = createService([{ name: 'addon', create }]);

        // Loads wait for creation; a duplicate create is refused.
        const creation = service.createProject(projectId, projectStorageConfig);
        await creating.promise;
        const first = service.loadProject(projectId, projectStorageConfig);
        const second = service.loadProject(projectId, projectStorageConfig);
        await expect(service.createProject(projectId, projectStorageConfig)).rejects.toThrow('being created');
        expect(create).not.toHaveBeenCalled();
        finishCreation.resolve();
        await creation;

        // Both callers share initialization, but conflicting config and early commits reject.
        await loading.promise;
        expect(create).toHaveBeenCalledTimes(1);
        await expect(service.commit(projectId, {}, 'not ready')).rejects.toMatchObject({ name: 'ProjectStorageLifecycleError' });
        await expect(service.loadProject(projectId, {
            ...projectStorageConfig, onDeviceFileStore: { name: 'CacheAPI', args: { projectId } },
        })).rejects.toMatchObject({ name: 'RepositoryConfigMismatchError' });
        finishLoading.resolve();
        await Promise.all([first, second]);

        // The first release leaves the project usable; the last tears it down.
        await service.unloadProject(projectId);
        expect(unloading).not.toHaveBeenCalled();
        await service.commit(projectId, Delta.fromChanges([
            Change.create(new DummyPage({ id: 'still-open', parent_id: '', name: 'Still open' })),
        ]).data, 'still open');
        await service.unloadProject(projectId);
        expect(unloading).toHaveBeenCalledTimes(1);
    });

    test('Failed creation and shared loading clean up and allow retry', async () => {
        const started = signal(), ready = signal();
        const loaded = jest.fn(async () => {}).mockImplementationOnce(async () => {
            started.resolve();
            await ready.promise;
            throw new Error('initialization failed');
        });
        const unloading = jest.fn(async () => {});
        const service = createService([{ name: 'addon', create: () => ({
            onProjectLoaded: loaded, onProjectUnloading: unloading,
        }) }]);
        const adapter = await getVcsAdapter(projectStorageConfig.onDeviceVcsAdapter);
        const close = jest.spyOn(adapter, 'close');

        // A failed write releases both the connection and the creation reservation.
        jest.spyOn(adapter, 'applyUpdate').mockRejectedValueOnce(new Error('write denied'));
        await expect(service.createProject(projectId, projectStorageConfig)).rejects.toThrow('write denied');
        expect(close).toHaveBeenCalledTimes(1);
        await service.createProject(projectId, projectStorageConfig);
        close.mockClear();

        // A failed shared load rejects both callers and drains only once.
        const failures = Promise.all([
            expect(service.loadProject(projectId, projectStorageConfig)).rejects.toThrow('initialization failed'),
            expect(service.loadProject(projectId, projectStorageConfig)).rejects.toThrow('initialization failed'),
        ]);
        await started.promise;
        ready.resolve();
        await failures;
        expect(close).toHaveBeenCalledTimes(1);
        expect(unloading).toHaveBeenCalledTimes(1);
        await service.loadProject(projectId, projectStorageConfig);
        await service.unloadProject(projectId);
        expect(unloading).toHaveBeenCalledTimes(2);
    });

    test('Final unload settles commits, drains in reverse order and permits reload after a hook failure', async () => {
        const writing = signal(), finishWrite = signal();
        const draining = signal(), finishDrain = signal();
        const order: string[] = [];
        const loaded = jest.fn(async () => {});
        let manager!: ProjectStorageManager;
        const service = createService([
            { name: 'dependency', create: psm => {
                manager = psm;
                return { onProjectLoaded: loaded, onProjectUnloading: async () => { order.push('dependency'); } };
            } },
            { name: 'dependent', create: () => ({
                onProjectLoaded: async () => {},
                onProjectUnloading: async () => {
                    // Draining must be able to acquire the released commit lock.
                    await navigator.locks.request(`storage-commit-${projectId}`, async () => {});
                    order.push('dependent');
                    draining.resolve();
                    await finishDrain.promise;
                    throw new Error('teardown failed');
                },
            }) },
        ]);
        const report = jest.spyOn(service, 'reportError');
        await service.createProject(projectId, projectStorageConfig);
        await service.loadProject(projectId, projectStorageConfig);
        const write = jest.spyOn(manager, 'syncDeltaToDomainStore').mockImplementation(async () => {
            writing.resolve(); await finishWrite.promise;
        });

        // Finish the accepted commit; refuse the one queued after final unload.
        const committing = service.commit(projectId, Delta.fromChanges([
            Change.create(new DummyPage({ id: 'in-flight', parent_id: '', name: 'In flight' })),
        ]).data, 'in flight');
        await writing.promise;
        const unloading = service.unloadProject(projectId);
        const rejected = expect(service.commit(projectId, {}, 'too late')).rejects.toMatchObject({ name: 'ProjectStorageLifecycleError' });
        const reloading = service.loadProject(projectId, projectStorageConfig);
        expect(order).toEqual([]);
        finishWrite.resolve();
        await Promise.all([committing, rejected, draining.promise]);
        expect(write).toHaveBeenCalledTimes(1);
        expect(loaded).toHaveBeenCalledTimes(1);

        // Reload waits for the whole drain, including cleanup after a failed hook.
        finishDrain.resolve();
        await Promise.all([unloading, reloading]);
        expect(order).toEqual(['dependent', 'dependency']);
        expect(report).toHaveBeenCalledWith(expect.stringContaining('teardown failed'));
        expect(loaded).toHaveBeenCalledTimes(2);
        await service.unloadProject(projectId);
    });

    test('Removal drains references, reserves erasure, tolerates missing storage and waits for loading', async () => {
        const order: string[] = [];
        const erasing = signal(), finishErase = signal();
        const loaded = jest.fn(async () => {});
        const create = jest.fn(() => ({
            onProjectLoaded: loaded,
            onProjectUnloading: async () => { order.push('drain'); },
        }));
        const erase = jest.fn(async (config: ProjectStorageConfig) => {
            expect(config).toEqual(projectStorageConfig);
            order.push('erase'); erasing.resolve(); await finishErase.promise;
        });
        const service = createService([{ name: 'history', create, eraseLocalStorage: erase }]);
        await service.createProject(projectId, projectStorageConfig);
        await service.loadProject(projectId, projectStorageConfig);
        await service.loadProject(projectId, projectStorageConfig);

        // Removal ignores references and blocks new work until erasure finishes.
        const removal = service.removeProject(projectId, projectStorageConfig);
        await erasing.promise;
        expect(order).toEqual(['drain', 'erase']);
        await expect(service.loadProject(projectId, projectStorageConfig)).rejects.toMatchObject({ name: 'ProjectStorageLifecycleError' });
        await expect(service.createProject(projectId, projectStorageConfig)).rejects.toMatchObject({ name: 'ProjectStorageLifecycleError' });
        await expect(service.commit(projectId, {}, 'late')).rejects.toMatchObject({ name: 'ProjectStorageLifecycleError' });
        finishErase.resolve();
        await removal;
        await service.unloadProject(projectId); // Late reference release is a no-op.
        await expect(Repository.open(projectStorageConfig.onDeviceVcsAdapter, true)).rejects.toThrow(/Branch.*not found/);

        // Unloaded/missing storage needs no addon instance; erase errors allow retry.
        await service.removeProject(projectId, projectStorageConfig);
        expect(create).toHaveBeenCalledTimes(1);
        erase.mockRejectedValueOnce(new Error('erase denied'));
        await expect(service.removeProject(projectId, projectStorageConfig)).rejects.toThrow('erase denied');
        await service.removeProject(projectId, projectStorageConfig);

        // A new load already in progress must settle before removal can drain it.
        const loading = signal(), finishLoad = signal();
        loaded.mockImplementationOnce(async () => {
            loading.resolve(); await finishLoad.promise; order.push('loaded');
        });
        await service.createProject(projectId, projectStorageConfig);
        order.length = 0;
        const rejected = expect(service.loadProject(projectId, projectStorageConfig)).rejects.toMatchObject({ name: 'ProjectStorageLifecycleError' });
        await loading.promise;
        const removing = service.removeProject(projectId, projectStorageConfig);
        expect(order).toEqual([]);
        finishLoad.resolve();
        await Promise.all([rejected, removing]);
        expect(order).toEqual(['loaded', 'drain', 'erase']);
        await expect(Repository.open(projectStorageConfig.onDeviceVcsAdapter, true)).rejects.toThrow(/Branch.*not found/);
    });

    test('Removal waits for successful or failed creation to clean up', async () => {
        const original = ProjectStorageManager.prototype.createProject;
        for (const fail of [false, true]) {
            const entered = signal(), finish = signal();
            let close!: jest.SpyInstance;
            jest.spyOn(ProjectStorageManager.prototype, 'createProject').mockImplementationOnce(async function (this: ProjectStorageManager) {
                await original.call(this);
                close = jest.spyOn(this.onDeviceRepo, 'close');
                entered.resolve();
                await finish.promise;
                if (fail) throw new Error('creation failed');
            });
            const erase = jest.fn(async () => { expect(close).toHaveBeenCalledTimes(1); });
            const service = createService([{ name: 'addon', create: () => {
                throw new Error('Removal must not construct addons');
            }, eraseLocalStorage: erase }]);
            const creation = service.createProject(projectId, projectStorageConfig);
            const created = fail ? expect(creation).rejects.toThrow('creation failed') : creation;
            await entered.promise;
            const loading = expect(service.loadProject(projectId, projectStorageConfig)).rejects.toThrow();
            const removal = service.removeProject(projectId, projectStorageConfig);
            expect(erase).not.toHaveBeenCalled();
            await expect(service.loadProject(projectId, projectStorageConfig)).rejects.toMatchObject({ name: 'ProjectStorageLifecycleError' });
            finish.resolve();
            await Promise.all([created, loading, removal]);
            expect(erase).toHaveBeenCalledTimes(1);
            await expect(Repository.open(projectStorageConfig.onDeviceVcsAdapter, true)).rejects.toThrow(/Branch.*not found/);
        }
    });

    test('File operations', async () => {
        // Load project
        await storageService.createProject(projectId, projectStorageConfig);
        await storageService.loadProject(projectId, projectStorageConfig, () => { });

        // Upload a file blob
        const blob = new Blob(['test content'], { type: 'text/plain' });
        const result = await storageService.addFile(projectId, blob, '/test.txt');

        expect(result).toBeDefined();
        expect(result.hash).toBeDefined();
        expect(result.path).toBeDefined();

        // Get the file blob
        const retrievedBlob = await storageService.getFile(projectId, result.path);
        expect(retrievedBlob).toBeDefined();
        expect(retrievedBlob.size).toBe(blob.size);
        expect(retrievedBlob.type).toBe(blob.type);
        expect(await retrievedBlob.text()).toBe('test content');

        // Remove the file
        await storageService.removeFile(projectId, result.path);

        // Verify it's removed by trying to get it again
        await expect(storageService.getFile(projectId, result.path)).rejects.toThrow();
    });
    test("Squash old prefix commits by TTL", async () => {
        await storageService.createProject(projectId, projectStorageConfig);
        const onUpdate = jest.fn<void, [RepoUpdateData]>();
        await storageService.loadProject(projectId, projectStorageConfig, onUpdate);
        const day = 24 * 60 * 60 * 1000;
        let now = 1_700_000_000_000;
        jest.spyOn(Date, "now").mockImplementation(() => now);

        // The old prefix creates a page and its child.
        const page = new DummyPage({ id: createId(), parent_id: "", name: "P0" });
        const delta0 = Delta.fromChanges([Change.create(page)]);
        const { result: c0 } = await commitAndObserve(storageService, projectId, onUpdate, delta0, "c0");

        now += 1;
        const note1 = new DummyNote({ id: createId(), parent_id: page.id, testProp: "N1" });
        const delta1 = Delta.fromChanges([Change.create(note1)]);
        const { result: c1, update: beforeSquash } = await commitAndObserve(storageService, projectId, onUpdate, delta1, "c1");
        expect(beforeSquash.commitGraph.commits.map(c => c.id)).toEqual([c0.commit.id, c1.commit.id]);

        // A recent commit triggers squash; c1 retains the old prefix's net delta.
        now += 3 * day;
        const note2 = new DummyNote({ id: createId(), parent_id: page.id, testProp: "N2" });
        const delta2 = Delta.fromChanges([Change.create(note2)]);
        const { result: c2, update } = await commitAndObserve(storageService, projectId, onUpdate, delta2, "c2");
        expect(new Map(update.commitGraph.commits.map(c => [c.id, c.parent_id]))).toEqual(new Map([
            [c1.commit.id, ''], [c2.commit.id, c1.commit.id],
        ]));
        expect(update.commitGraph.branches).toEqual([{ name: 'dev1', head_commit_id: c2.commit.id }]);

        const commits = await storageService.getCommits(projectId, [c1.commit.id, c2.commit.id]);
        expect(commits[0].delta_data).toEqual({ ...delta0.data, ...delta1.data });
        expect(commits[0].snapshot_hash).toBe(c1.commit.snapshot_hash);
        expect(commits[1]).toEqual(c2.commit);
        expect(update.upsertedCommits).toEqual(expect.arrayContaining(commits));

        const replayed = new InMemoryStore();
        replayed.applyDelta(new Delta(commits[0].delta_data));
        expect(replayed.data()).toEqual({ entities: [dumpToDict(page), dumpToDict(note1)] });
        replayed.applyDelta(new Delta(commits[1].delta_data));
        expect(replayed.data()).toEqual({
            entities: [dumpToDict(page), dumpToDict(note1), dumpToDict(note2)],
        });
        expect((await buildHashTree(replayed)).rootHash()).toBe(c2.commit.snapshot_hash);
    });

});
