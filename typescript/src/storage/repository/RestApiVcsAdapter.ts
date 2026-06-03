import { Commit, CommitData } from "../version-control/Commit";
import { CommitGraph, CommitGraphData } from "../version-control/CommitGraph";
import { InternalRepoUpdate, VcsAdapter } from "./VcsAdapter";
import { buildRestApiAuthHeaders, RestApiAuthConfig } from "../rest-api/Auth";

interface RepoUpdateData {
    commitGraph: CommitGraphData;
    upsertedCommits: CommitData[];
}

export class RestApiVcsAdapter implements VcsAdapter {
    private _pathPrefix: string;
    private _localBranchName: string;
    private _baseUrl: string;
    private _auth: RestApiAuthConfig;
    private _cachedCommitGraph: CommitGraph | null = null;

    constructor(
        pathPrefix: string,
        localBranchName: string,
        baseUrl: string,
        auth: RestApiAuthConfig,
    ) {
        this._pathPrefix = pathPrefix;
        this._localBranchName = localBranchName;
        this._baseUrl = baseUrl;
        this._auth = auth;
    }

    get localBranchName(): string {
        return this._localBranchName;
    }

    private _headers(): HeadersInit {
        return buildRestApiAuthHeaders(this._auth);
    }

    private _url(path: string, params?: URLSearchParams): string {
        const normalizedPath = path.startsWith("/") ? path : `/${path}`;
        const url = new URL(`${this._baseUrl}${normalizedPath}`);
        if (params) {
            url.search = params.toString();
        }
        return url.toString();
    }

    private async _getJson<T>(url: string): Promise<T> {
        const response = await fetch(url, {
            method: "GET",
            headers: this._headers(),
            cache: "no-store",
        });

        if (!response.ok) {
            throw new Error(
                `REST API request failed (${response.status} ${response.statusText}) for ${url}`,
            );
        }

        return (await response.json()) as T;
    }

    async getCommitGraph(): Promise<CommitGraph> {
        const params = new URLSearchParams();
        params.set("branch", this._localBranchName);

        const url = this._url(
            `${this._pathPrefix}/commit-graph`,
            params,
        );
        const commitGraphData = await this._getJson<CommitGraphData>(url);
        this._cachedCommitGraph = CommitGraph.fromData(commitGraphData);
        return CommitGraph.fromData(commitGraphData);
    }

    async getCommits(ids: string[]): Promise<Commit[]> {
        if (!ids || ids.length === 0) {
            return [];
        }

        const params = new URLSearchParams();
        params.set("branch", this._localBranchName);
        for (const id of ids) {
            params.append("ids", id);
        }

        const url = this._url(
            `${this._pathPrefix}/commits`,
            params,
        );
        const commitDataList = await this._getJson<CommitData[]>(url);
        const commitDataById = new Map(commitDataList.map((c) => [c.id, c]));

        return ids.map((id) => {
            const commitData = commitDataById.get(id);
            if (!commitData) {
                throw new Error(`Commit ${id} not found on REST API backend`);
            }
            return new Commit(commitData);
        });
    }

    async applyUpdate(update: InternalRepoUpdate): Promise<void> {
        const hasChanges = update.addedCommits.length > 0
            || update.updatedCommits.length > 0
            || update.removedCommits.length > 0
            || update.addedBranches.length > 0
            || update.updatedBranches.length > 0
            || update.removedBranches.length > 0;

        if (!hasChanges) {
            return;
        }

        const commitGraph = this._cachedCommitGraph
            ? CommitGraph.fromData(this._cachedCommitGraph.data())
            : await this.getCommitGraph();

        update.removedCommits.forEach((commit) => {
            commitGraph.removeCommit(commit.id);
        });
        update.updatedCommits.forEach((commit) => {
            commitGraph.removeCommit(commit.id);
            commitGraph.addCommit(commit.metadata());
        });
        update.addedCommits.forEach((commit) => {
            commitGraph.addCommit(commit.metadata());
        });
        update.addedBranches.forEach((branch) => {
            if (!commitGraph.branch(branch.name)) {
                commitGraph.createBranch(branch.name);
            }
            commitGraph.setBranch(branch.name, branch.head_commit_id);
        });
        update.updatedBranches.forEach((branch) => {
            commitGraph.setBranch(branch.name, branch.head_commit_id);
        });
        update.removedBranches.forEach((branch) => {
            if (commitGraph.branch(branch.name)) {
                commitGraph.removeBranch(branch.name);
            }
        });

        const repoUpdateData: RepoUpdateData = {
            commitGraph: commitGraph.data(),
            upsertedCommits: [
                ...update.addedCommits.map((commit) => commit.data()),
                ...update.updatedCommits.map((commit) => commit.data()),
            ],
        };

        await this.applyRepoUpdateData(repoUpdateData);
        this._cachedCommitGraph = commitGraph;
    }

    private async applyRepoUpdateData(updateData: RepoUpdateData): Promise<void> {
        const url = this._url(
            `${this._pathPrefix}/repo-update`,
        );
        const response = await fetch(url, {
            method: "POST",
            headers: {
                ...this._headers(),
                "Content-Type": "application/json",
            },
            body: JSON.stringify(updateData),
        });
        if (!response.ok) {
            throw new Error(
                `Failed to apply repo update (${response.status} ${response.statusText})`,
            );
        }
    }

    close(): void {
        // Nothing to release for HTTP adapter.
    }

    async eraseStorage(): Promise<void> {
        // Read-only adapter does not own persistent storage.
    }

}
