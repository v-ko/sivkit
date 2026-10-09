import { Change } from "sivkit/model/Change";
import { Delta } from "sivkit/model/Delta";
import { ProjectStorageConfig } from "sivkit/storage/management/ProjectStorageManager";
import { StorageServiceProxy, StorageProxyState } from "sivkit/storage/management/StorageServiceProxy";
import { clearInMemoryAdapterInstances, RepoUpdateData, VcsAdapterConfig } from "sivkit/storage/repository/Repository";
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

    function createProxy() {
        const proxy = new StorageServiceProxy();
        proxies.push(proxy);
        return proxy;
    }

    beforeEach(async () => {
        proxies = [];
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

        // Remove (works even when not loaded — temporarily loads internally)
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
