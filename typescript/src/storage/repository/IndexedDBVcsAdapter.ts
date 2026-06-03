import { Commit, CommitMetadataData } from "../version-control/Commit";
import { openDB, DBSchema, IDBPDatabase, deleteDB } from 'idb';
import { VcsAdapter, BranchMetadata, InternalRepoUpdate } from "./VcsAdapter";
import { DeltaData } from "../../model/Delta";
import { CommitGraph } from "../version-control/CommitGraph";
import { DebugConnectionTracker, wrapDbWithTransactionDebug } from "../management/DebugUtils";
import { getLogger } from "../../logging";


let log = getLogger('IndexedDBVcsAdapter');

const DEBUG_DB = false;

function repoStoreName(projectId: string) {
    return 'repoStore-' + projectId;
}

interface RepoDB extends DBSchema {
    branches: {
        key: string;
        value: BranchMetadata;
        indexes: { 'by-name': string };
    };
    commits: {
        key: string;
        value: CommitMetadataData;
        indexes: { 'by-id': string };
    };
    deltas: {
        key: string;
        value: { commitId: string, delta: DeltaData };
        indexes: { 'by-commitId': string };
    };
}

export class IndexedDBVcsAdapter implements VcsAdapter {
    private _db: IDBPDatabase<RepoDB> | null = null;
    private _projectId: string;

    constructor(projectId: string) {
        this._projectId = projectId;
        log.info('Instantiated IndexedDBVcsAdapter for project:', projectId)
    }

    async initialize(): Promise<void> {
        if (this._db) {
            throw new Error('IndexedDB already initialized');
        }
        let dbName = repoStoreName(this._projectId);
        log.info(`[initialize] Opening IndexedDB "${dbName}" for project "${this._projectId}"`);

        let DBConstructor = openDB;
        if (DEBUG_DB) {
            DBConstructor = DebugConnectionTracker.openDBWithTracking;
        }

        this._db = await DBConstructor<RepoDB>(dbName, 1, {
            upgrade(db) {
                let branchesStore = db.createObjectStore('branches', { keyPath: 'name' });
                let commitsStore = db.createObjectStore('commits', { keyPath: 'id' });
                let deltasStore = db.createObjectStore('deltas', { keyPath: 'commitId' });

                branchesStore.createIndex('by-name', 'name');
                commitsStore.createIndex('by-id', 'id');
                deltasStore.createIndex('by-commitId', 'commitId');
            },
            blocked() {
                log.error(`IndexedDB blocked - another connection is still open`);
            },
            blocking() {
                log.error(`IndexedDB blocking another connection`);
            }
        });
        log.info(`Opened IndexedDB for project ${this._projectId}`);

        if (DEBUG_DB) {
            this._db = wrapDbWithTransactionDebug(this._db);
        }

        if (!this._db) {
            throw new Error('Failed to open IndexedDB');
        }

        this._db.addEventListener('versionchange', () => {
            log.warning(`IndexedDB version change detected`);
        });
    }

    get db(): IDBPDatabase<RepoDB> {
        if (!this._db) {
            throw new Error('IndexedDB not open');
        }
        return this._db;
    }

    close() {
        if (this._db) {
            log.info('Closing IndexedDB connection');
            this._db.close();
        } else {
            log.warning('[close] IndexedDB already closed');
        }
    }

    async getCommitGraph(): Promise<CommitGraph> {
        try {
            const tx = this.db.transaction(['branches', 'commits'], 'readonly');
            const branchesStore = tx.objectStore('branches');
            const commitsStore = tx.objectStore('commits');

            // Retrieve all branches and commits, handle each request potentially failing
            const branchesPromise = branchesStore.getAll();
            const commitsPromise = commitsStore.getAll();

            const [branches, commits] = await Promise.all([branchesPromise, commitsPromise]);

            // Await transaction completion to catch any errors post data fetching
            await tx.done;

            log.info(`[getCommitGraph] DB "${this._projectId}": ` +
                `branches=${branches.length} [${branches.map(b => b.name).join(', ')}], ` +
                `commits=${commits.length}`);

            return CommitGraph.fromData({
                branches: branches,
                commits: commits
            });
        } catch (error: any) { // Typing as DOMException if you're specifically handling those types of errors
            log.error('Failed to retrieve commit graph: ' + error.message);
            throw new Error('Failed to retrieve commit graph due to database error');
        }
    }

    async getCommits(ids: string[]): Promise<Commit[]> {
        if (!ids || ids.length === 0) {
            return [];
        }

        try {
            const tx = this.db.transaction(['commits', 'deltas'], 'readonly');
            const commitsStore = tx.objectStore('commits');
            const deltasStore = tx.objectStore('deltas');

            const commits: Commit[] = [];

            for (const id of ids) {
                try {
                    const commitData = await commitsStore.get(id);
                    if (commitData) {
                        const delta = await deltasStore.get(commitData.id);
                        if (delta) {
                            // commitData.deltaData = delta.delta;
                            commits.push(new Commit({...commitData, delta_data: delta.delta}));
                        } else {
                            log.error('Delta not found for commit ' + commitData.id);
                        }
                    } else {
                        log.error('Commit not found for ID ' + id);
                    }
                } catch (requestError: any) { // You can use 'any' or 'unknown' here, then narrow with an instanceof check if necessary
                    log.error('Error handling commit or delta request: ' + requestError.message);
                    // Optionally check if (requestError instanceof DOMException) for more specific handling
                }
            }

            await tx.done;
            if (commits.length === 0 && ids.length > 0) {
                log.warning('No commits found for the provided IDs', ids);
            }

            return commits;
        } catch (txError: any) {
            log.error('Transaction failed: ' + txError.message);
            throw txError; // Rethrow or handle transaction error as per application need
        }
    }

    async applyUpdate(update: InternalRepoUpdate): Promise<void> {
        const {
            addedCommits,
            removedCommits,
            updatedCommits,
            addedBranches,
            updatedBranches,
            removedBranches
        } = update;

        // Start applying the changes
        const tx = this.db.transaction(['branches', 'commits', 'deltas'], 'readwrite');
        const branchesStore = tx.objectStore('branches');
        const commitsStore = tx.objectStore('commits');
        const deltasStore = tx.objectStore('deltas');

        // Remove redundant commits
        for (let commit of removedCommits) {
            await commitsStore.delete(commit.id);
            await deltasStore.delete(commit.id);
        }

        // Update existing commits (full replace to keep commits+deltas consistent)
        for (let commit of updatedCommits) {
            await commitsStore.delete(commit.id);
            await deltasStore.delete(commit.id);
            await commitsStore.add(commit.metadata().data());
            if (!commit.deltaData) {
                throw new Error('Delta data missing for updated commit ' + commit.id);
            }
            await deltasStore.add({ commitId: commit.id, delta: commit.deltaData });
        }

        // Add new commits
        for (let commit of addedCommits) {
            log.info('Adding commit', commit)
            await commitsStore.add(commit.metadata().data());
            if (!commit.deltaData) {
                throw new Error('Delta data missing for commit ' + commit.id);
            }
            await deltasStore.add({ commitId: commit.id, delta: commit.deltaData });
        }

        // Update branches
        for (let branch of updatedBranches) {
            await branchesStore.put(branch);
        }

        // Add new branches
        for (let branch of addedBranches) {
            await branchesStore.add(branch);
        }

        // Remove branches
        for (let branch of removedBranches) {
            await branchesStore.delete(branch.name);
        }

        await tx.done;
    }

    async eraseStorage(): Promise<void> {
        log.info('Erasing IndexedDB storage for project', this._projectId);
        this.close();
        try {
            await deleteDB(repoStoreName(this._projectId), {
                blocked() {
                    log.warning('deleteDB is blocked – another connection is still open.');
                }
            });
        } catch (e) {
            log.error('Error erasing IndexedDB storage for project', this._projectId, e);
        }
        log.info('Erased IndexedDB storage for project', this._projectId);
    }

}
