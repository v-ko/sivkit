import { Commit } from "../version-control/Commit";
import { CommitGraph } from "../version-control/CommitGraph";
import { getLogger } from "../../logging";
import { VcsAdapter, InternalRepoUpdate } from "./VcsAdapter";

const log = getLogger('InMemoryRepository')


export class InMemoryVcsAdapter implements VcsAdapter {
    private _commitGraph: CommitGraph = new CommitGraph();
    private _commitById: Map<string, Commit> = new Map();

    async getCommitGraph(): Promise<CommitGraph> {
        return CommitGraph.fromData(this._commitGraph.data());
    }

    async getCommits(ids: string[]): Promise<Commit[]> {
        return ids.map((id) => {
            const commit = this._commitById.get(id);
            if (!commit) {
                throw new Error(`Commit ${id} not found`);
            }
            return commit;
        });
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

        // Remove old commits
        for (const commit of removedCommits) {
            this._commitById.delete(commit.id);
            this._commitGraph.removeCommit(commit.id);
        }

        // Update existing commits (full replace: metadata + delta)
        for (const commit of updatedCommits) {
            // Replace full commit in map
            this._commitById.delete(commit.id);
            this._commitById.set(commit.id, commit);
            // Refresh metadata in graph (remove then add)
            this._commitGraph.removeCommit(commit.id);
            this._commitGraph.addCommit(commit.metadata());
        }

        // Add new commits
        for (const commit of addedCommits) {
            this._commitById.set(commit.id, commit);
            this._commitGraph.addCommit(commit.metadata());
        }

        // Add new branches
        for (const branch of addedBranches) {
            this._commitGraph.createBranch(branch.name);
            if (branch.head_commit_id) {
                this._commitGraph.setBranch(branch.name, branch.head_commit_id);
            }
        }

        // Update branches
        for (const branch of updatedBranches) {
            this._commitGraph.setBranch(branch.name, branch.head_commit_id);
        }

        // Remove branches
        for (const branch of removedBranches) {
            this._commitGraph.removeBranch(branch.name);
        }
    }

    close(): void {
        // Nothing to do for in-memory storage
    }

    async eraseStorage(): Promise<void> {
        this._commitGraph = new CommitGraph();
        this._commitById = new Map();
    }
}
