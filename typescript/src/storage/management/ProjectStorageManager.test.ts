import { ProjectStorageManager, ProjectStorageConfig } from "./ProjectStorageManager";
import { clearInMemoryAdapterInstances, VcsAdapterConfig } from "../repository/Repository";
import { Change } from "../../model/Change";
import { Delta } from "../../model/Delta";
import { DummyPage } from "../test-utils";


const INMEM_PROJECT_STORAGE_CONFIG: VcsAdapterConfig = {
    name: 'InMemorySingletonForTesting',
    args: {
        localBranchName: 'dev1',
        projectId: 'test-project-id',
    }
}

describe("ProjectStorageManager base functionality", () => {
    let projectStorageManager: ProjectStorageManager;
    let projectId: string;
    let projectStorageConfig: ProjectStorageConfig;

    beforeEach(() => {
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

        projectStorageManager = new ProjectStorageManager(projectStorageConfig);
    });
    afterEach(async () => {
        try {
            await projectStorageManager.shutdown();
        } finally {
            clearInMemoryAdapterInstances();
        }
    });

    test("Create and reload project preserves committed entities and history", async () => {
        await projectStorageManager.createProject();
        expect(projectStorageManager.fileStore).toBeDefined();
        const page = new DummyPage({ id: 'p1', parent_id: '', name: 'Saved page' });
        const commit = await projectStorageManager.onDeviceRepo.commit(
            Delta.fromChanges([Change.create(page)]), 'add page',
        );

        await projectStorageManager.shutdown();
        projectStorageManager = new ProjectStorageManager(projectStorageConfig);
        await projectStorageManager.loadProject();
        expect(projectStorageManager.onDeviceRepo.headStore.findOne({ id: 'p1' })).toEqual(page);
        expect(projectStorageManager.onDeviceRepo.hashTree.rootHash()).toBe(commit.snapshotHash);
        const graph = await projectStorageManager.onDeviceRepo.getCommitGraph();
        expect(graph.branchCommits('dev1').map(c => c.id)).toEqual([commit.id]);
    });

    test("Erase local storage", async () => {
        await projectStorageManager.createProject();
        const page = new DummyPage({ id: 'p1', parent_id: '', name: 'Saved page' });
        await projectStorageManager.onDeviceRepo.commit(
            Delta.fromChanges([Change.create(page)]), 'add page',
        );
        const path = '/saved.txt';
        await projectStorageManager.fileStore.addFile(new Blob(['saved']), path);

        await projectStorageManager.eraseLocalStorage();
        await expect(projectStorageManager.fileStore.getFile(path)).rejects.toThrow('File not found');

        await projectStorageManager.shutdown();
        projectStorageManager = new ProjectStorageManager(projectStorageConfig);
        await expect(projectStorageManager.loadProject()).rejects.toThrow(/Branch.*not found/);
        await projectStorageManager.createProject();
        expect([...projectStorageManager.onDeviceRepo.headStore.find()]).toEqual([]);
    });

    test("Erase local storage before initialization", async () => {
        // Should not throw, just log warning
        await projectStorageManager.eraseLocalStorage();
    });

    test("Constructor throws on branch name mismatch", () => {
        const mismatchedConfig = {
            ...projectStorageConfig,
            deviceBranchName: 'different-branch'
        };

        expect(() => {
            new ProjectStorageManager(mismatchedConfig);
        }).toThrow();
    });
});
