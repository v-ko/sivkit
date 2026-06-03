import { BranchMetadata } from "../repository/VcsAdapter";
import { CommitMetadata, CommitMetadataData } from "./Commit";

export interface CommitGraphData {
    branches: BranchMetadata[];
    commits: CommitMetadataData[];
}

export class CommitGraph {
    /**
     * An implementation of the version control graph used for synchronisation
     * of state between clients. It stores the last state and infers snapshots
     * by subracting previous deltas.
     */
    private _branches: BranchMetadata[] = [];
    private _commitsById: Map<string, CommitMetadata> = new Map();

    static fromData(data: CommitGraphData): CommitGraph { // , localBranchName: string
        let sg = new CommitGraph();
        sg._branches = data.branches

        // Create commit objects
        for (let commitData of data.commits) {
            sg._commitsById.set(commitData.id, new CommitMetadata(commitData));
        }
        return sg;
    }
    data(): CommitGraphData {
        return {
            branches: structuredClone(this._branches),
            commits: Array.from(this._commitsById.values()).map(c => c.data())
        }
    }
    createBranch(branchName: string) {
        if (this._branches.find(b => b.name === branchName)) {
            throw new Error("Branch already exists: " + branchName);
        }

        this._branches.push({ name: branchName, head_commit_id: null });
    }
    setBranch(branchName: string, headCommitId: string | null) {
        let branch = this._branches.find(b => b.name === branchName);
        if (!branch) {
            this._branches.push({ name: branchName, head_commit_id: headCommitId });
        } else {
            branch.head_commit_id = headCommitId;
        }
    }
    removeBranch(branchName: string) {
        let index = this._branches.findIndex(b => b.name === branchName);
        if (index === -1) {
            throw new Error("[removeBranch] Branch not found: " + branchName);
        }
        this._branches.splice(index, 1);
    }

    branches(): BranchMetadata[] {
        return structuredClone(this._branches);
    }
    branch(branchName: string): BranchMetadata | undefined {
        let branch = this._branches.find(b => b.name === branchName);
        return branch
    }
    headCommit(branchName: string): CommitMetadata | null {
        let branch = this.branch(branchName);
        if (!branch) {
            throw new Error("[headCommit] Branch not found: " + branchName);
        }
        if (branch.head_commit_id === null) {
            return null;
        }
        let commit = this._commitsById.get(branch.head_commit_id);
        if (!commit) {
            throw new Error("Commit not found");
        }
        return commit;
    }
    commits(): CommitMetadata[] {
        return Array.from(this._commitsById.values());
    }
    commitsBetween(startCommitId: string | null, endCommitId: string | null): CommitMetadata[] {
        //
        //
        /**
         * If start is null, return all commits up to the root
         * If end is null, return all commits from start to the latest
         *
         * start-to-end (start=id, end=null) is not efficiently implemented
         */

        // If there's an end commit - start from it and go back by parentId
        // until the start commit or the root
        if (endCommitId !== null) {
            let endCommit = this.commit(endCommitId);
            if (!endCommit) {
                throw new Error("End commit not found " + endCommitId);
            }

            let commits = [endCommit];
            let commit: CommitMetadata | undefined = endCommit;
            while (commit.parentId) {
                commit = this.commit(commit.parentId);
                if (!commit) {
                    throw new Error("Parent commit not found");
                }

                if (startCommitId !== null && commit.id === startCommitId) {
                    break;
                }

                commits.push(commit);
            }

            // reverse to get the chronological order
            commits.reverse();
            return commits;

        } else if (startCommitId !== null) {
            // If there's no end commit, start from the start commit and go forward
            let startCommit = this.commit(startCommitId);
            if (!startCommit) {
                throw new Error("Start commit not found");
            }

            let allCommits = this.commits();
            let commits = [startCommit];
            let commit: CommitMetadata | undefined = startCommit;
            while (commit) {
                let nextCommit = allCommits.find(c => c.parentId === commit!.id);
                if (!nextCommit) {
                    break;
                }
                commits.push(nextCommit);
                commit = nextCommit;
            }
            return commits;
        } else {
            throw new Error("Both start and end commit ids are null");
        }
    }
    removeCommit(commitId: string) {
        this._commitsById.delete(commitId);
    }
    branchCommits(branchName: string): CommitMetadata[] {
        let branch = this.branch(branchName);
        if (!branch) {
                throw new Error("[branchCommits] Branch not found: " + branchName);
        }
        if (!branch.head_commit_id) {
            return [];
        }

        let commit = this.commit(branch.head_commit_id);
        if (!commit) {
            throw new Error("Head commit not found");
        }

        let commits = [commit];
        while (commit.parentId) {
            commit = this.commit(commit.parentId);
            if (!commit) {
                throw new Error("Parent commit not found");
            }
            commits.push(commit);
        }
        // reverse to get the chronological order
        commits.reverse();
        return commits;
    }
    addCommit(commit: CommitMetadata) {
        // Drop the delta and copy the object
        commit = new CommitMetadata(commit.data());

        this._commitsById.set(commit.id, commit);
    }
    commit(commitId: string): CommitMetadata | undefined {
        let commit = this._commitsById.get(commitId);
        return commit;
    }
    clear() {
        this._branches = [];
        this._commitsById.clear();
    }
}
