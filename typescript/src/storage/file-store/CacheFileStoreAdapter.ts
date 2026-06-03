import { FileStoreAdapter, AddFileResult } from "./FileStoreAdapter";
import { generateContentHash } from "../../util/media";
import { getLogger } from "../../logging";

const log = getLogger('CacheFileStoreAdapter');

export class CacheFileStoreAdapter implements FileStoreAdapter {
  private _projectId: string;
  private _cacheName: string;
  private _cache: Cache | null = null;

  constructor(projectId: string) {
    this._projectId = projectId;
    this._cacheName = `pamet-file-${projectId}`;
  }

  async init(): Promise<void> {
    try {
      this._cache = await caches.open(this._cacheName);
      log.info(`Opened Cache API store: ${this._cacheName}`);
    } catch (error) {
      log.error('Failed to initialize Cache API:', error);
      throw new Error(`Failed to initialize CacheFileStoreAdapter: ${error}`);
    }
  }

  private get cache(): Cache {
    if (!this._cache) {
      throw new Error('Cache not initialized. Call init() first.');
    }
    return this._cache;
  }

  private _getCacheKey(path: string): string {
    return `files/${path}`;
  }

  async addFile(blob: Blob, path: string): Promise<AddFileResult> {
    log.info(`Adding file to cache: ${path} (${blob.type}, ${blob.size} bytes)`);
    const hash = (await generateContentHash(blob)).slice(0, 32);
    const cacheKey = this._getCacheKey(path);

    const response = new Response(blob.slice(), {
      headers: {
        'Content-Type': blob.type,
        'Content-Length': blob.size.toString(),
        'X-Content-Hash': hash,
      }
    });

    await this.cache.put(cacheKey, response);
    log.info(`Added file to cache: ${cacheKey}`);

    return { hash, path };
  }

  async getFile(path: string): Promise<Blob> {
    const cacheKey = this._getCacheKey(path);
    const response = await this.cache.match(cacheKey);
    if (!response) {
      throw new Error(`File not found in cache: ${cacheKey}`);
    }
    return await response.blob();
  }

  async removeFile(path: string): Promise<void> {
    const cacheKey = this._getCacheKey(path);
    const deleted = await this.cache.delete(cacheKey);
    if (deleted) {
      log.info(`Removed file from cache: ${cacheKey}`);
    } else {
      log.warning(`File not found for deletion: ${cacheKey}`);
    }
  }

  async eraseStorage(): Promise<void> {
    log.info(`Erasing CacheAPI storage: ${this._cacheName}`);
    this._cache = null;
    await caches.delete(this._cacheName);
    log.info(`Erased CacheAPI storage: ${this._cacheName}`);
  }

  async close(): Promise<void> {
    this._cache = null;
    log.info(`Closed CacheFileStoreAdapter: ${this._cacheName}`);
  }
}
