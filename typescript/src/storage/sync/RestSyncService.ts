import { getLogger } from "../../logging";
import { Delta } from "../../model/Delta";
import { SerializedEntityData, loadFromDict } from "../../model/Entity";
import { InMemoryStore } from "../domain-store/InMemoryStore";
import { StoreSyncService } from "./StoreSyncService";

const log = getLogger('RestSyncLink');

export interface RestSyncLinkConfig {
    /** Base URL for the store-sync endpoint, e.g. "http://localhost:8000/config/store" */
    endpoint: string;
    /** Optional headers to include in every request (e.g. auth) */
    headers?: () => HeadersInit;
}

interface FullStateResponse {
    seq: number;
    entities: SerializedEntityData[];
}

export class RestSyncService implements StoreSyncService {
    private _store: InMemoryStore | null = null;
    private _endpoint: string;
    private _headers: (() => HeadersInit) | undefined;
    private _seq: number = 0;
    private _ownSeqs: Set<number> = new Set();
    private _abortController: AbortController = new AbortController();
    private _disposed: boolean = false;

    constructor(config: RestSyncLinkConfig) {
        this._endpoint = config.endpoint;
        this._headers = config.headers;
    }

    setStore(store: InMemoryStore): void {
        this._store = store;
    }

    private get store(): InMemoryStore {
        if (!this._store) {
            throw new Error('Store not set. Call setStore() before using RestSyncLink.');
        }
        return this._store;
    }

    private _buildHeaders(): Record<string, string> {
        const base: Record<string, string> = { 'Content-Type': 'application/json' };
        if (this._headers) {
            Object.assign(base, this._headers());
        }
        return base;
    }

    async initialize(): Promise<void> {
        await this._fullLoad();
        void this._connectStream();
    }

    private async _fullLoad(): Promise<void> {
        const response = await fetch(this._endpoint, {
            method: 'GET',
            headers: this._buildHeaders(),
            cache: 'no-store',
        });
        if (!response.ok) {
            throw new Error(`RestSyncLink: GET ${this._endpoint} failed (${response.status})`);
        }
        const data = await response.json() as FullStateResponse;
        this._seq = data.seq;

        // Replace store contents with server state
        const entities = data.entities.map(d => loadFromDict(d));
        this.store.clear();
        this.store.loadData(entities, 'remote');
    }

    async pushDelta(delta: Delta): Promise<void> {
        const response = await fetch(`${this._endpoint}/changes`, {
            method: 'POST',
            headers: this._buildHeaders(),
            body: JSON.stringify({ delta: delta.data }),
        });

        if (!response.ok) {
            log.error(`RestSyncLink: POST ${this._endpoint}/changes failed (${response.status})`);
            return;
        }

        const data = await response.json() as { seq: number };
        this._ownSeqs.add(data.seq);
    }

    // -- SSE stream --------------------------------------------------------

    private async _connectStream(): Promise<void> {
        while (!this._disposed) {
            try {
                await this._streamOnce();
            } catch (e) {
                if (this._disposed) break;
                log.error('RestSyncLink: stream error:', e);
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    }

    private async _streamOnce(): Promise<void> {
        const headers = this._buildHeaders();
        headers['Last-Event-ID'] = String(this._seq);
        delete headers['Content-Type'];

        const response = await fetch(`${this._endpoint}/changes/stream`, {
            method: 'GET',
            headers,
            cache: 'no-store',
            signal: this._abortController.signal,
        });

        if (!response.ok) {
            throw new Error(`SSE connect failed (${response.status})`);
        }

        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const parts = buffer.split('\n\n');
                buffer = parts.pop()!;

                for (const part of parts) {
                    if (!part.trim()) continue;
                    const event = this._parseSSEEvent(part);

                    if (event.type === 'stale') {
                        log.info('RestSyncLink: stale, doing full reload');
                        await this._fullLoad();
                        return; // Reconnect with new _seq
                    }

                    if (!event.id) continue;
                    const seq = parseInt(event.id, 10);
                    if (isNaN(seq)) continue;

                    if (this._ownSeqs.has(seq)) {
                        this._ownSeqs.delete(seq);
                    } else {
                        const parsed = JSON.parse(event.data);
                        if (parsed.delta) {
                            const remoteDelta = new Delta(parsed.delta);
                            if (Object.keys(remoteDelta.data).length > 0) {
                                this.store.applyDelta(remoteDelta, 'remote', true);
                            }
                        }
                    }
                    this._seq = seq;
                }
            }
        } finally {
            reader.releaseLock();
        }
    }

    private _parseSSEEvent(raw: string): { type: string; id: string; data: string } {
        let type = 'message';
        let id = '';
        let data = '';
        for (const line of raw.split('\n')) {
            if (line.startsWith('event: ')) type = line.slice(7);
            else if (line.startsWith('id: ')) id = line.slice(4);
            else if (line.startsWith('data: ')) data += line.slice(6);
        }
        return { type, id, data };
    }



    dispose(): void {
        this._disposed = true;
        this._abortController.abort();
    }
}
