import { getLogger } from "../../logging";
import { Commit, CommitData } from "../version-control/Commit";
import { CommitGraph, CommitGraphData } from "../version-control/CommitGraph";
import { VcsAdapter, InternalRepoUpdate, CorruptVcsStoreError } from "./VcsAdapter";
import { inferRepoChangesFromGraphs, sanityCheckAndHydrateInternalRepoUpdate } from "../management/sync-utils";
import { Delta, DeltaData, squashDeltas } from "../../model/Delta";
import { createId } from "../../util/base";
import { HangingSubtreesError, HashTree, buildHashTree, updateHashTree } from "../version-control/HashTree";
import { InMemoryStore, DEFAULT_INDEX_CONFIGS_LIST } from "../domain-store/InMemoryStore";
import { Entity, EntityData } from "../../model/Entity";
import { InMemoryVcsAdapter } from "./InMemoryVcsAdapter";
import { IndexedDBVcsAdapter } from "./IndexedDBVcsAdapter";
import { RestApiVcsAdapter } from "./RestApiVcsAdapter";
import { RestApiAuthConfig } from "../rest-api/Auth";
let log = getLogger('Repository')

export type VcsAdapterNames = "InMemory" | "IndexedDB" | "RestApi" | "InMemorySingletonForTesting";

// For running tests only
let _inmemadapter_instances_by_id: Map<string, InMemoryVcsAdapter> = new Map();

export function clearInMemoryAdapterInstances() {
    _inmemadapter_instances_by_id.clear();
}

export class RepositoryIntegrityError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RepositoryIntegrityError";
    }
}

export class MissingBranchError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "MissingBranchError";
    }
}

export { CorruptVcsStoreError };

export interface VcsAdapterArgs {
    projectId: string;
    localBranchName: string;
    baseUrl?: string;
    auth?: RestApiAuthConfig;
}

export interface VcsAdapterConfig {
    name: VcsAdapterNames
    args: VcsAdapterArgs;
}

export interface ResetFilter {
    relativeToHead: number;
}

export interface RepoUpdateData {
    commitGraph: CommitGraphData;
    upsertedCommits: CommitData[];
}

export interface CommitOptions {
    skipConflictingChanges?: boolean;
}

export async function getVcsAdapter(config: VcsAdapterConfig): Promise<VcsAdapter> {
    if (config.name === 'InMemory') {
        return new InMemoryVcsAdapter();
    } else if (config.name === 'IndexedDB') {
        const { projectId } = config.args;
        const adapter = new IndexedDBVcsAdapter(projectId);
        await adapter.initialize();
        return adapter;
    } else if (config.name === 'RestApi') {
        const { projectId, localBranchName, baseUrl, auth } = config.args;
        if (!baseUrl) {
            throw new Error("RestApi VCS adapter requires args.baseUrl in config");
        }
        if (!auth) {
            throw new Error("RestApi VCS adapter requires args.auth in config");
        }
        return new RestApiVcsAdapter(
            projectId,
            localBranchName,
            baseUrl,
            auth,
        );
    } else if (config.name === 'InMemorySingletonForTesting') {
        const { projectId } = config.args;
        if (!_inmemadapter_instances_by_id.has(projectId)) {
            const inMemAdapter = new InMemoryVcsAdapter();
            _inmemadapter_instances_by_id.set(projectId, inMemAdapter);
        }
        return _inmemadapter_instances_by_id.get(projectId)!;
    } else {
        throw new Error(`Unknown VCS adapter type: ${config.name}`);
    }
}

export class Repository {
    _vcsAdapter: VcsAdapter;
    private _isCaching: boolean;

    _currentBranch: string;
    private _headStore: InMemoryStore | null = null;
    private _commitGraph: CommitGraph = new CommitGraph();
    private _commitById: Map<string, Commit> = new Map();
    private _hashTree: HashTree | null = null;

    private constructor(
        storageAdapter: VcsAdapter,
        adapterConfig: VcsAdapterConfig,
        enableCaching: boolean) {

        this._vcsAdapter = storageAdapter;
        this._isCaching = enableCaching;
        this._currentBranch = adapterConfig.args.localBranchName;

        // Initialize the commit graph and head store
        if (enableCaching) {
            log.info(`Repository constructor: caching enabled. Using VCS adapter: ${adapterConfig.name}`);
            this._commitGraph = new CommitGraph();
            this._headStore = new InMemoryStore(DEFAULT_INDEX_CONFIGS_LIST);
        } else {
            log.info(`Repository constructor: caching disabled. Using VCS adapter: ${adapterConfig.name}`);
        }
    }

    private static async init(config: VcsAdapterConfig, enableCaching: boolean): Promise<Repository> {
        const storageAdapter = await getVcsAdapter(config);
        const repo = new Repository(storageAdapter, config, enableCaching);
        // Always init with defualt current branch. There's no repo without
        // a head. And then we'll pull from wherever
        repo._commitGraph.createBranch(repo._currentBranch);
        return repo
    }

    static async open(config: VcsAdapterConfig, enableCaching: boolean, headStoreData?: Entity<EntityData>[]): Promise<Repository> {
        let repo = await Repository.init(config, enableCaching);

        log.info(`Opening repository with caching: ${enableCaching}, VCS adapter: ${config.name}`);

        try {
            const commitGraph = await repo._vcsAdapter.getCommitGraph();
            const allBranches = commitGraph.branches();
            const allCommits = commitGraph.commits();
            log.info(`[Repository.open] Loaded commit graph for branch "${repo._currentBranch}". ` +
                `Branches (${allBranches.length}): [${allBranches.map(b => b.name).join(', ')}], ` +
                `Commits: ${allCommits.length}`);

            let branch = commitGraph.branch(repo._currentBranch);
            if (branch === undefined) {
                throw new MissingBranchError(`Branch "${repo._currentBranch}" not found in the commit graph. ` +
                    `Branches (${allBranches.length}): [${allBranches.map(b => b.name).join(', ')}], ` +
                    `Commits: ${allCommits.length}, ` +
                    `VCS adapter: ${config.name}, projectId: ${config.args.projectId}`);
            }

            if (!repo._isCaching) {
                log.info(`Repository opened without caching. Using VCS adapter: ${config.name}`);
                return repo;
            }

            if (headStoreData) {
                // Populate headStore from provided entity data (e.g. domain store)
                for (const entity of headStoreData) {
                    repo.headStore.insertOne(entity);
                }
                log.info(`Populated headStore from provided data: ${headStoreData.length} entities`);
                repo._hashTree = await buildHashTree(repo.headStore);

                // Populate the commit graph cache from the adapter so that
                // getCommitGraph() returns the real graph (needed by sync/OPSS).
                // Without this, the cached graph stays empty and sync sees no
                // commits to replay, leaving the main-thread store empty.
                const adapterCommitIds = allCommits.map(c => c.id);
                const fullCommits = adapterCommitIds.length > 0
                    ? await repo._vcsAdapter.getCommits(adapterCommitIds)
                    : [];
                for (const commit of fullCommits) {
                    repo._commitById.set(commit.id, commit);
                    repo._commitGraph.addCommit(commit.metadata());
                }
                for (const branch of allBranches) {
                    repo._commitGraph.setBranch(branch.name, branch.head_commit_id);
                }
            } else {
                // Initialize an empty hash tree before hydration so
                // _applyInternalUpdateToCache can update it incrementally.
                repo._hashTree = await buildHashTree(repo.headStore);
                await repo.hydrateCacheFromVcsAdapter();
            }
            log.info(`Repository opened with caching enabled. Using VCS adapter: ${config.name}`);
            return repo;
        } catch (error) {
            // The caller never receives a failed repository and cannot close it.
            repo.close();
            throw error;
        }
    }

    static async create(config: VcsAdapterConfig, enableCaching: boolean): Promise<Repository> {
        const repo = await Repository.init(config, enableCaching);

        try {
            // The constructor creates the cached branch; persist it in the adapter.
            await repo._vcsAdapter.applyUpdate({
                addedCommits: [],
                removedCommits: [],
                updatedCommits: [],
                addedBranches: [{ name: repo._currentBranch, head_commit_id: null }],
                updatedBranches: [],
                removedBranches: []
            });

            log.info(`Created repository with caching: ${enableCaching}, current branch: ${repo._currentBranch}`);
            if (repo._isCaching) {
                repo._hashTree = await buildHashTree(repo.headStore);
            }
            return repo;
        } catch (error) {
            repo.close();
            throw error;
        }
    }

    get headStore(): InMemoryStore {
        if (!this._headStore) {
            throw new Error("Head store is not available. Caching might be disabled.");
        }
        return this._headStore;
    }

    get hashTree(): HashTree {
        if (!this._hashTree) {
            throw new Error("Hash tree is not initialized");
        }
        return this._hashTree;
    }

    async getCommitGraph(): Promise<CommitGraph> {
        if (this._isCaching) {
            // Return a defensive clone so callers cannot mutate internal graph
            return CommitGraph.fromData(this._commitGraph.data());
        }
        return await this._vcsAdapter.getCommitGraph();
    }

    async getCommits(ids: string[]): Promise<Commit[]> {
        if (this._isCaching) {
            const commits: Commit[] = [];
            for (const id of ids) {
                const commit = this._commitById.get(id);
                if (!commit) {
                    throw new Error(`Commit ${id} not found in cache`);
                }
                commits.push(commit);
            }
            return commits;
        }
        return this._vcsAdapter.getCommits(ids);
    }

    async commit(delta: Delta, message: string, options: CommitOptions = {}): Promise<Commit> {
        if (!this._currentBranch) {
            throw new Error("Current branch is not set");
        }
        if (!this._isCaching) {
            throw new Error("Cannot create a commit without head state caching enabled");
        }
        if (delta.isEmpty()) {
            throw new Error("Cannot commit an empty delta");
        }

        log.info('Committing', delta, message)
        // Apply to the head store
        const appliedDelta = this.headStore.applyDelta(delta, undefined, options.skipConflictingChanges === true);

        // Get snapshotHash
        try {
            await updateHashTree(this.hashTree, this.headStore, appliedDelta)
        } catch (e) {
            this.headStore.applyDelta(appliedDelta.reversed()); // Restore the store state, commit is unsuccessful
            if (e instanceof HangingSubtreesError) {
                throw Error('Error updating hashtree. You\'re probably trying to commit objects to the store who\'s parents are not present in it. Error: ' + e)
            }
            throw Error('Error updating hash tree: ' + e)
        }
        let snapshotHash = this.hashTree.rootHash()

        // Create commit
        const commitGraph = this._commitGraph!;
        let commits = commitGraph.branchCommits(this._currentBranch);

        let parentId = ''
        if (commits.length > 0) {
            // Initial commit
            parentId = commits.at(-1)!.id
        }
        let commit = new Commit({
            id: createId(),
            parent_id: parentId,
            snapshot_hash: snapshotHash,
            delta_data: appliedDelta.data,
            message: message,
            timestamp: Date.now()
        })

        // Add commit to sync graph
        commitGraph.addCommit(commit.metadata())
        this._commitById.set(commit.id, commit)
        commitGraph.setBranch(this._currentBranch, commit.id)

        const branch = commitGraph.branch(this._currentBranch)!;

        const internalUpdate: InternalRepoUpdate = {
            addedCommits: [commit],
            removedCommits: [],
            updatedCommits: [],
            addedBranches: [],
            updatedBranches: [branch],
            removedBranches: []
        };
        await this._vcsAdapter.applyUpdate(internalUpdate);

        return commit;
    }

    async createBranch(branchName: string): Promise<void> {
        if (!this._isCaching) {
            // In non-caching mode, this should probably be an atomic operation
            // on the storage adapter, which is not implemented.
            // For now, we only support this in caching mode.
            throw new Error("Cannot create a branch without head state caching enabled");
        }
        const commitGraph = this._commitGraph!;
        commitGraph.createBranch(branchName);
        const branch = commitGraph.branch(branchName)!;

        const update: InternalRepoUpdate = {
            addedCommits: [],
            removedCommits: [],
            updatedCommits: [],
            addedBranches: [branch],
            updatedBranches: [],
            removedBranches: []
        };
        await this._vcsAdapter.applyUpdate(update);
        // throw Error(`Created branch ${JSON.stringify(await this._storageAdapter.getCommitGraph())} for name ${branchName}`)
    }

    async pull(repository: Repository | VcsAdapter) {
        let remoteGraph = await repository.getCommitGraph()
        const ownGraph = await this.getCommitGraph();

        let repoUpdateSlim = inferRepoChangesFromGraphs(ownGraph, remoteGraph);

        // Get upserted commits in full (added + updated)
        const upsertIds = [
            ...repoUpdateSlim.addedCommits.map((c) => c.id),
            ...repoUpdateSlim.updatedCommits.map((c) => c.id)
        ];
        let upsertedCommits = upsertIds.length > 0 ? await repository.getCommits(upsertIds) : [];

        // Sanity check and hydrate (added + updated) with the upserted commits (with deltas)
        let repoUpdate = sanityCheckAndHydrateInternalRepoUpdate(repoUpdateSlim, upsertedCommits);

        // Persist the changes to the underlying storage first
        await this._vcsAdapter.applyUpdate(repoUpdate);

        if (this._isCaching) {
            await this._applyInternalUpdateToCache(repoUpdate, remoteGraph);
        }
    }

    async hydrateCacheFromVcsAdapter() {
        if (!this._isCaching) {
            throw new Error("Cannot hydrate cache without caching enabled");
        }

        log.info('Hydrating cache from VCS adapter');
        // Get the commit graph from the storage adapter
        const remoteGraph = await this._vcsAdapter.getCommitGraph();
        const ownGraph = await this.getCommitGraph();

        let repoUpdateSlim = inferRepoChangesFromGraphs(ownGraph, remoteGraph);

        // Get upserted commits in full (added + updated)
        const upsertIds = [
            ...repoUpdateSlim.addedCommits.map((c) => c.id),
            ...repoUpdateSlim.updatedCommits.map((c) => c.id)
        ];
        let upsertedCommits = upsertIds.length > 0 ? await this._vcsAdapter.getCommits(upsertIds) : [];

        let repoUpdate = sanityCheckAndHydrateInternalRepoUpdate(repoUpdateSlim, upsertedCommits);

        await this._applyInternalUpdateToCache(repoUpdate, remoteGraph);
    }

    async applyRepoUpdate(updateInfo: RepoUpdateData): Promise<void> {
        let remoteGraph = CommitGraph.fromData(updateInfo.commitGraph);
        let upsertedCommits = updateInfo.upsertedCommits.map((data) => new Commit(data));

        // Form the internalRepoUpdate object
        let repoUpdateSlim = inferRepoChangesFromGraphs(this._commitGraph, remoteGraph);
        // Sanity check and hydrate addedCommits with the upsertedCommits (with deltas included)
        let repoUpdate = sanityCheckAndHydrateInternalRepoUpdate(repoUpdateSlim, upsertedCommits);

        // Persist the changes to the underlying storage first
        await this._vcsAdapter.applyUpdate(repoUpdate);

        if (this._isCaching) {
            await this._applyInternalUpdateToCache(repoUpdate, remoteGraph);
        }
    }

    async reset(filter: ResetFilter): Promise<void> {
        if (!this._currentBranch) {
            throw new Error("Current branch is not set");
        }
        if (!this._isCaching) {
            throw new Error("Cannot reset without head state caching enabled");
        }
        const commitGraph = this._commitGraph!;

        // Update the head store state to reflect the requested branch/head pos
        let { relativeToHead } = filter

        if (relativeToHead === 0) {
            return
        } else if (relativeToHead > 0) {
            throw new Error("Reset forward not supported")
        }

        let headCommit = commitGraph.headCommit(this._currentBranch)
        if (!headCommit) {
            throw new Error("No head commit found")
        }

        let branchCommits = commitGraph.branchCommits(this._currentBranch)
        let index = branchCommits.indexOf(headCommit)
        if (index === -1) {
            throw new Error("Head commit not found in branch commits")
        }

        let targetIndex = index + relativeToHead
        if (targetIndex < 0) {
            throw new Error("Resetting too far back")
        }

        let targetCommit = branchCommits.at(targetIndex)
        if (!targetCommit) {
            throw new Error("Target commit not found")
        }

        // Revert the head store state by applying the deltas for the removed
        // commits in reverse
        let commitsToRevert = branchCommits.slice(targetIndex + 1)
        let commitsToRevertFull = await this.getCommits(commitsToRevert.map(c => c.id));
        const reversedDeltas = commitsToRevertFull.map(c => new Delta(c.deltaData as DeltaData).reversed().data);
        const squashedDelta = squashDeltas(reversedDeltas);
        this.headStore.applyDelta(squashedDelta);


        // Remove from commit graph and local commits
        for (let commit of commitsToRevert) {
            this._commitById.delete(commit.id)
            commitGraph.removeCommit(commit.id)
        }

        // Update hash tree
        await updateHashTree(this.hashTree, this.headStore, squashedDelta)
        commitGraph.setBranch(this._currentBranch, targetCommit.id)

        // Assert that the hash is correct
        let snapshotHash = this.hashTree.rootHash()
        if (snapshotHash !== targetCommit.snapshotHash) {
            throw new RepositoryIntegrityError("Snapshot hash of the head store state does not match the one of the applied commit (on reset)")
        }

        // Persist changes
        const branch = commitGraph.branch(this._currentBranch)!;
        const update: InternalRepoUpdate = {
            addedCommits: [],
            removedCommits: commitsToRevert,
            updatedCommits: [],
            addedBranches: [],
            updatedBranches: [branch],
            removedBranches: []
        };
        await this._vcsAdapter.applyUpdate(update);
    }

    async _applyInternalUpdateToCache(repoChanges: InternalRepoUpdate, remoteGraph: CommitGraph): Promise<void> {
        // If caching, apply the now-persisted changes to the in-memory cache
        const cacheGraph = this._commitGraph!;

        let {
            addedCommits,
            removedCommits,
            updatedCommits,
            addedBranches,
            updatedBranches,
            removedBranches
        } = repoChanges

        // Do the commit removal
        removedCommits.forEach((commit) => {
            this._commitById.delete(commit.id)
            cacheGraph.removeCommit(commit.id)
        })

        // Update commits (full replace: metadata + delta)
        updatedCommits.forEach((commit) => {
            // Replace in map
            this._commitById.set(commit.id, commit)
            // Refresh metadata in graph
            cacheGraph.removeCommit(commit.id)
            cacheGraph.addCommit(commit.metadata())
        })

        // Add new commits to the local map for further processing
        addedCommits.forEach((commit) => {
            this._commitById.set(commit.id, commit)
            cacheGraph.addCommit(commit.metadata())
        })

        let commitsBehind: string[] = [] // ids
        let remoteHeadCommit = remoteGraph.headCommit(this._currentBranch!)
        let localHeadCommit = cacheGraph.headCommit(this._currentBranch!)

        if (remoteHeadCommit) {
            let remoteHeadId = remoteHeadCommit.id
            let localHeadId = localHeadCommit ? localHeadCommit.id : null
            if (remoteHeadId !== localHeadId) {
                // Get the commits behind
                let behind = remoteGraph.commitsBetween(localHeadId, remoteHeadId)
                commitsBehind = behind.map((c) => c.id)
            }
        } else {
            if (localHeadCommit) {
                throw new Error("Irrational changes - remote branch empty, while local is not")
            }
        }

        if (commitsBehind.length === 0) {
            log.info('No new commits to apply to headStore.')
        } else {
            // Squash deltas and apply the update to the head store
            let deltas: DeltaData[] = []

            for (let commitId of commitsBehind) {
                let commit = this._commitById.get(commitId)
                if (commit && commit.deltaData) {
                    deltas.push(commit.deltaData)
                } else {
                    throw new Error(`Critical: Missing commit or deltaData for ${commitId}`)
                }
            }

            // Apply to head store
            let squashedDelta = squashDeltas(deltas)
            this.headStore.applyDelta(squashedDelta)

            // Update the hash tree
            await updateHashTree(this.hashTree, this.headStore, squashedDelta)

            // Assert hash is correct
            let snapshotHash = this.hashTree.rootHash()
            if (snapshotHash !== remoteHeadCommit!.snapshotHash) {
                log.error('Snapshot hash mismatch after pull. Remote head commit:', remoteHeadCommit, 'Hash tree root:', this.hashTree.rootHash())
                throw new RepositoryIntegrityError("Snapshot hash mismatch after pull")
            }
        }

        // Apply branch changes to the cache
        addedBranches.forEach((branch) => {
            cacheGraph.createBranch(branch.name)
        })
        updatedBranches.forEach((branch) => {
            cacheGraph.setBranch(branch.name, branch.head_commit_id)
        })
        removedBranches.forEach((branch) => {
            if (branch.name === this._currentBranch) {
                throw new Error("Cannot remove current branch")
            }
            cacheGraph.removeBranch(branch.name)
        })
    }

    async eraseStorage(): Promise<void> {
        return this._vcsAdapter.eraseStorage();
    }

    close() {
        log.info('Repo close called. Closing VCS adapter.');
        this._vcsAdapter.close();
    }
}


export  async function verifyRepositoryIntegrity(repository: Repository | VcsAdapter, branchName: string): Promise<boolean> {
    log.info(`Verifying integrity of repository for branch "${branchName}"`);

    const commitGraph: CommitGraph = await repository.getCommitGraph();
    const branchCommitsMinimal = commitGraph.branchCommits(branchName);

    if (branchCommitsMinimal.length === 0) {
        log.info("No commits in branch, integrity check skipped.");
        return true;
    }

    const commitIds = branchCommitsMinimal.map(c => c.id);
    const branchCommits = await repository.getCommits(commitIds);

    const store = new InMemoryStore();
    let hashTree: HashTree = await buildHashTree(store);

    for (const commit of branchCommits) {
        log.info(`Verifying commit ${commit.id}`);
        const delta = new Delta(commit.deltaData);

        // Apply delta to the in-memory store
        store.applyDelta(delta);

        // Update the hash tree
        await updateHashTree(hashTree, store, delta);

        // Compare the hash tree's root hash with the commit's snapshot hash
        const calculatedHash = hashTree.rootHash();
        if (calculatedHash !== commit.snapshotHash) {
            let deltaSize = Object.keys(commit.deltaData).length
            let deltaDataStr = '';
            if (deltaSize < 100) {
                deltaDataStr = JSON.stringify(commit.deltaData, null, 2);
            }
            log.error(`Integrity check failed at commit ${commit.id}: expected hash ${commit.snapshotHash}, but got ${calculatedHash}. Delta size is ${deltaSize}. Delta data:\n ${deltaDataStr}`);

            return false;
        }
    }

    log.info("Repository integrity verified successfully.");
    return true;
}
