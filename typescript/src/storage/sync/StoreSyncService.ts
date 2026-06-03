import { Delta } from "../../model/Delta";
import { InMemoryStore } from "../domain-store/InMemoryStore";

export interface StoreSyncService {
    setStore(store: InMemoryStore): void;
    initialize(): Promise<void>;
    pushDelta(delta: Delta): Promise<void>;
    dispose(): void;
}
