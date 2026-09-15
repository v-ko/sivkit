import { Commit, CommitMetadata } from "../version-control/Commit";
import { CommitGraph } from "../version-control/CommitGraph";

export interface BranchMetadata {
    name: string;
    head_commit_id: string | null;
}

export interface InternalRepoUpdateNoDeltas {
    addedCommits: CommitMetadata[];
    removedCommits: CommitMetadata[];
    updatedCommits: CommitMetadata[];
    addedBranches: BranchMetadata[];
    updatedBranches: BranchMetadata[];
    removedBranches: BranchMetadata[];
}

export interface InternalRepoUpdate extends Omit<InternalRepoUpdateNoDeltas, 'addedCommits' | 'updatedCommits'> {
    addedCommits: Commit[];
    updatedCommits: Commit[];
}

export interface VcsAdapter {
    getCommitGraph(): Promise<CommitGraph>;
    getCommits(ids: string[]): Promise<Commit[]>;
    applyUpdate(update: InternalRepoUpdate): Promise<void>;
    close(): void;
    eraseStorage(): Promise<void>;
}

/**
 * Thrown when the underlying VCS store is physically unreadable (e.g. a value
 * lost after an unclean shutdown). Signals that the store cannot be recovered
 * in place and should be discarded and rebuilt. Distinct from logic/usage
 * errors, which must surface. See IndexedDB 3.0 §6.2: a failed value read is a
 * "NotReadableError" DOMException; disk/IO faults surface as "UnknownError".
 */
export class CorruptVcsStoreError extends Error {
    readonly commitId?: string;
    constructor(message: string, options?: { commitId?: string; cause?: unknown }) {
        super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
        this.name = "CorruptVcsStoreError";
        this.commitId = options?.commitId;
    }
}
