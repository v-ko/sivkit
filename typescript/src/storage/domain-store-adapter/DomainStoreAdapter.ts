import type { DeltaData } from "../../model/Delta";
import type { SerializedEntityData } from "../../model/Entity";
import type { RestApiAuthConfig } from "../rest-api/Auth";

/**
 * Adapter for an external domain store (e.g. desktop backend filesystem).
 *
 * Provides entity queries and change exchange.
 * Lifecycle (bridge setup/teardown) and polling are handled by StorageAddons.
 */
export interface DomainStoreAdapter {
    find(filter?: Record<string, unknown>): Promise<SerializedEntityData[]>;
    applyDelta(deltaData: DeltaData): Promise<void>;
}

export type DomainStoreAdapterNames = "RestApi";

export interface DomainStoreAdapterArgs {
    projectId: string;
    baseUrl: string;
    auth: RestApiAuthConfig;
}

export interface DomainStoreConfig {
    name: DomainStoreAdapterNames;
    args: DomainStoreAdapterArgs;
}
