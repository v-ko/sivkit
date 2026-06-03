import { Delta, DeltaData } from "../../model/Delta";

export interface CommitMetadataData {
    id: string;
    parent_id: string;
    message: string;
    timestamp: number;
    snapshot_hash: string;
    delta_data?: never;  // Annotation trick to not allow passing Commit objects where CommitMetadata is expected
}

export interface CommitData extends Omit<CommitMetadataData, 'delta_data'> {
    delta_data: DeltaData;
}

export class CommitMetadata {
    id: string;
    parentId: string;
    snapshotHash: string;
    timestamp: number;
    message: string;

    constructor(data: CommitMetadataData) {
        this.id = data.id;
        this.parentId = data.parent_id;
        this.snapshotHash = data.snapshot_hash;
        this.timestamp = data.timestamp;
        this.message = data.message;
    }

    data(): CommitMetadataData {
        return {
            id: this.id,
            parent_id: this.parentId,
            snapshot_hash: this.snapshotHash,
            timestamp: this.timestamp,
            message: this.message,
        };
    }
}

export class Commit {
    id: string;
    parentId: string;
    snapshotHash: string;
    timestamp: number;
    message: string;
    deltaData: DeltaData;

    constructor(data: CommitData) {
        this.id = data.id;
        this.parentId = data.parent_id;
        this.snapshotHash = data.snapshot_hash;
        this.timestamp = data.timestamp;
        this.message = data.message;
        this.deltaData = data.delta_data;
    }

    data(): CommitData {
        return {
            id: this.id,
            parent_id: this.parentId,
            snapshot_hash: this.snapshotHash,
            timestamp: this.timestamp,
            message: this.message,
            delta_data: this.deltaData,
        };
    }

    get delta(): Delta {
        return new Delta(this.deltaData);
    }

    metadata(): CommitMetadata {
        let { delta_data: deltaData, ...metadata } = this.data();
        return new CommitMetadata(metadata);
    }
}
