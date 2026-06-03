import { getLogger } from "../../logging";
import { FileStoreAdapter, AddFileResult } from "./FileStoreAdapter";
import { generateContentHash } from "../../util/media";

const log = getLogger('InMemoryFileStoreAdapter');

export class InMemoryFileStoreAdapter implements FileStoreAdapter {
    private _files: Map<string, Blob> = new Map();

    async addFile(blob: Blob, path: string): Promise<AddFileResult> {
        log.info(`Adding file to in-memory store: ${path} (${blob.type}, ${blob.size} bytes)`);
        const hash = (await generateContentHash(blob)).slice(0, 32);
        this._files.set(path, blob);
        log.info(`Added file to in-memory store: ${path}`);
        return { hash, path };
    }

    async getFile(path: string): Promise<Blob> {
        const blob = this._files.get(path);
        if (!blob) {
            log.error(`File not found in in-memory store: ${path}`);
            throw new Error(`File not found: ${path}`);
        }
        return blob;
    }

    async removeFile(path: string): Promise<void> {
        const deleted = this._files.delete(path);
        if (deleted) {
            log.info(`Removed file from in-memory store: ${path}`);
        } else {
            log.warning(`File not found for deletion in in-memory store: ${path}`);
        }
    }

    async eraseStorage(): Promise<void> {
        this._files.clear();
        log.info('Erased InMemoryFileStoreAdapter.');
    }

    async close(): Promise<void> {
        this._files.clear();
        log.info('Closed and cleared InMemoryFileStoreAdapter.');
    }
}
