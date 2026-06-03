/**
 * Bidirectional WebSocket store sync.
 *
 * A single class that operates as either **authority** (owns the canonical
 * state, sends `full_state` on connect) or **receiver** (expects `full_state`
 * on connect, loads it into the store). After the handshake both roles are
 * symmetric: local deltas are sent and ACKed, remote deltas are received,
 * applied, and ACKed.
 *
 * Since `loadData` does **not** fire `onChanges`, the hydration delta is
 * invisible to consumers wired via `store.onChanges`.  Only real user-action
 * deltas trigger the callback.
 *
 * An optional `onFullStateReceived` callback (no arguments) is invoked
 * after the full-state has been loaded into the store, for consumers
 * that need to react to the initial snapshot (e.g. seeding a repository).
 *
 * Wire protocol (JSON messages):
 *
 *     {"type": "full_state", "seq": <number>, "entities": [...]}
 *     {"type": "delta",      "seq": <number>, "delta": {DeltaData}}
 *     {"type": "ack",        "seq": <number>}
 */

import { getLogger } from "../../logging";
import { Delta, DeltaData } from "../../model/Delta";
import { SerializedEntityData, loadFromDict, dumpToDict } from "../../model/Entity";
import { InMemoryStore } from "../domain-store/InMemoryStore";
import { StoreSyncService } from "./StoreSyncService";

const log = getLogger('WebSocketSyncService');

const ACK_TIMEOUT_MS = 5000;

export type WebSocketSyncServiceRole = 'authority' | 'receiver';

export interface WebSocketSyncServiceConfig {
    /** 'authority' sends full_state on connect; 'receiver' expects it. */
    role: WebSocketSyncServiceRole;
    /** WebSocket URL, e.g. "ws://localhost:8000/config/store/ws" */
    url: string;
    /** Optional sub-protocols to pass to the WebSocket constructor. */
    protocols?: string[];
}

interface PendingAck {
    resolve: () => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

type WsSyncMessage =
    | { type: 'full_state'; seq: number; entities: SerializedEntityData[] }
    | { type: 'delta'; seq: number; base_seq: number; delta: DeltaData }
    | { type: 'ack'; seq: number }
    | { type: 'reject'; seq: number; server_seq: number };

export class WebSocketSyncService implements StoreSyncService {
    private _store: InMemoryStore | null = null;
    private _ws: WebSocket | null = null;
    private _role: WebSocketSyncServiceRole;
    private _url: string;
    private _protocols: string[] | undefined;
    private _seq: number = 0;
    private _pendingAcks: Map<number, PendingAck> = new Map();
    private _disposed = false;

    constructor(config: WebSocketSyncServiceConfig) {
        this._role = config.role;
        this._url = config.url;
        this._protocols = config.protocols;
    }

    // -- StoreSyncService interface ----------------------------------------

    setStore(store: InMemoryStore): void {
        this._store = store;
    }

    private get store(): InMemoryStore {
        if (!this._store) throw new Error('Store not set');
        return this._store;
    }

    /**
     * Open the WebSocket and complete the handshake.
     *
     * - Authority: sends `full_state` immediately after open.
     * - Receiver: waits for the `full_state` message.
     *
     * Resolves once the handshake is complete and the message loop is
     * running.
     */
    async initialize(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const ws = new WebSocket(this._url, this._protocols);
            this._ws = ws;
            let handshakeComplete = false;

            ws.onopen = () => {
                if (this._role === 'authority') {
                    this._sendFullState();
                    handshakeComplete = true;
                    resolve();
                }
                // Receiver: resolve is deferred to onmessage (full_state)
            };

            ws.onmessage = (event) => {
                const msg = JSON.parse(event.data) as WsSyncMessage;

                // Complete receiver handshake on first full_state
                if (!handshakeComplete && this._role === 'receiver') {
                    if (msg.type !== 'full_state') {
                        reject(new Error(
                            `Expected full_state, got ${msg.type}`
                        ));
                        ws.close();
                        return;
                    }
                    this._handleFullState(msg);
                    handshakeComplete = true;
                    resolve();
                    return;
                }

                this._handleMessage(msg);
            };

            ws.onerror = () => {
                if (!handshakeComplete) {
                    reject(new Error('WebSocket connection failed'));
                }
            };

            ws.onclose = () => {
                this._disposed = true;
                // Reject all pending ACKs
                for (const [, entry] of this._pendingAcks) {
                    clearTimeout(entry.timer);
                    entry.reject(new Error('Connection closed'));
                }
                this._pendingAcks.clear();
            };
        });
    }

    /**
     * Send a local delta to the remote peer.
     *
     * Returns a Promise that resolves when the remote peer ACKs.
     * Callers may ignore the promise for fire-and-forget semantics.
     */
    pushDelta(delta: Delta): Promise<void> {
        if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
            log.error('Cannot push delta: WebSocket not connected');
            return Promise.reject(new Error('WebSocket not connected'));
        }

        const base_seq = this._seq;
        this._seq++;
        const seq = this._seq;

        this._send({ type: 'delta', seq, base_seq, delta: delta.data });

        // Return a promise that resolves on ACK or rejects on timeout
        return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this._pendingAcks.has(seq)) {
                    this._pendingAcks.delete(seq);
                    reject(new Error(`ACK timeout for seq ${seq}`));
                }
            }, ACK_TIMEOUT_MS);

            this._pendingAcks.set(seq, { resolve, reject, timer });
        });
    }

    dispose(): void {
        this._disposed = true;
        if (this._ws) {
            this._ws.close();
            this._ws = null;
        }
        for (const [, entry] of this._pendingAcks) {
            clearTimeout(entry.timer);
        }
        this._pendingAcks.clear();
    }

    // -- Message handling --------------------------------------------------

    private _handleMessage(msg: WsSyncMessage): void {
        switch (msg.type) {
            case 'full_state':
                this._handleFullState(msg);
                break;

            case 'delta': {
                const delta = new Delta(msg.delta);
                this.store.applyDelta(delta, 'remote');
                this._send({ type: 'ack', seq: msg.seq });
                this._seq = Math.max(this._seq, msg.seq);
                break;
            }

            case 'ack': {
                const entry = this._pendingAcks.get(msg.seq);
                if (entry) {
                    clearTimeout(entry.timer);
                    entry.resolve();
                    this._pendingAcks.delete(msg.seq);
                }
                break;
            }

            case 'reject': {
                log.warning(`Delta seq ${msg.seq} rejected (server_seq=${msg.server_seq})`);
                const rejEntry = this._pendingAcks.get(msg.seq);
                if (rejEntry) {
                    clearTimeout(rejEntry.timer);
                    rejEntry.reject(new Error(
                        `Delta rejected: stale base_seq (server_seq=${msg.server_seq})`
                    ));
                    this._pendingAcks.delete(msg.seq);
                }
                break;
            }

            default:
                log.warning('Unknown WS message type:', (msg as any).type);
        }
    }

    // -- Helpers -----------------------------------------------------------

    private _send(msg: WsSyncMessage): void {
        if (this._ws && this._ws.readyState === WebSocket.OPEN) {
            this._ws.send(JSON.stringify(msg));
        }
    }

    private _sendFullState(): void {
        const entities: SerializedEntityData[] = [];
        for (const entity of this.store.find({})) {
            entities.push(dumpToDict(entity));
        }
        this._send({ type: 'full_state', seq: this._seq, entities });
    }

    private _handleFullState(msg: { seq: number; entities: SerializedEntityData[] }): void {
        this._seq = msg.seq ?? 0;
        const entities = (msg.entities ?? []).map(
            (d: SerializedEntityData) => loadFromDict(d)
        );
        this.store.clear();
        this.store.loadData(entities, 'remote');
    }
}
