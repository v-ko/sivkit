import { ProjectStorageManager, ProjectStorageConfig } from "./ProjectStorageManager";
import { clearInMemoryAdapterInstances, VcsAdapterConfig } from "../repository/Repository";


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
        clearInMemoryAdapterInstances();
    });

    test("Create and load project", async () => {
        // Create project
        await projectStorageManager.createProject();
        expect(projectStorageManager.onDeviceRepo).toBeDefined();
        expect(projectStorageManager.fileStore).toBeDefined();
        expect(projectStorageManager.onDeviceRepo.hashTree).toBeDefined();
        const commitGraph = await projectStorageManager.onDeviceRepo.getCommitGraph();
        expect(commitGraph).toBeDefined();
        expect(commitGraph.branches()).toHaveLength(1);

        // Shutdown and reload
        await projectStorageManager.shutdown();
    });

    test("Erase local storage", async () => {
        await projectStorageManager.createProject();

        // Should not throw
        await projectStorageManager.eraseLocalStorage();

        await projectStorageManager.shutdown();
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
