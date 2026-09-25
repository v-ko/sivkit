import { Delta } from "../../model/Delta";
import { InMemoryStore } from "../domain-store/InMemoryStore";
import { StoreSyncService } from "./StoreSyncService";
import { action } from "../../registries/Action";

/**
 * Shared base for store sync services.
 *
 * Owns the store reference and the receive-side apply seam. Incoming remote
 * deltas go through `applyRemoteDelta`, which applies them with origin
 * 'remote', inside a service action if the store requires one.
 */
export abstract class StoreSyncServiceBase implements StoreSyncService {
    protected _store: InMemoryStore | null = null;

    setStore(store: InMemoryStore): void {
        this._store = store;
    }

    protected get store(): InMemoryStore {
        if (!this._store) {
            throw new Error('Store not set. Call setStore() before using the sync service.');
        }
        return this._store;
    }

    protected applyRemoteDelta(delta: Delta, skipIrrationalOperations: boolean = false): void {
        if (this.store.requireAction) {
            this._applyRemoteDeltaInAction(delta, skipIrrationalOperations);
        } else {
            this.store.applyDelta(delta, 'remote', skipIrrationalOperations);
        }
    }

    @action({ name: 'applyRemoteDelta', issuer: 'service' })
    private _applyRemoteDeltaInAction(delta: Delta, skipIrrationalOperations: boolean): void {
        this.store.applyDelta(delta, 'remote', skipIrrationalOperations);
    }

    abstract initialize(): Promise<void>;
    abstract pushDelta(delta: Delta): Promise<void>;
    abstract dispose(): void;
}
