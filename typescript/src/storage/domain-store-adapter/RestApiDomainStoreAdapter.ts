import type { DeltaData } from "../../model/Delta";
import type { SerializedEntityData } from "../../model/Entity";
import { getLogger } from "../../logging";
import { buildRestApiAuthHeaders, RestApiAuthConfig } from "../rest-api/Auth";
import type { DomainStoreAdapter } from "./DomainStoreAdapter";

const log = getLogger('RestApiDomainStoreAdapter');

/**
 * Domain store adapter that talks to a backend REST API.
 * Provides entity queries and change exchange.
 */
export class RestApiDomainStoreAdapter implements DomainStoreAdapter {
    protected _projectId: string;
    protected _baseUrl: string;
    protected _auth: RestApiAuthConfig;

    constructor(projectId: string, baseUrl: string, auth: RestApiAuthConfig) {
        this._projectId = projectId;
        this._baseUrl = baseUrl;
        this._auth = auth;
    }

    protected _headers(): HeadersInit {
        return buildRestApiAuthHeaders(this._auth);
    }

    protected _projectUrl(path: string): string {
        return `${this._baseUrl}/desktop/projects/${encodeURIComponent(this._projectId)}${path}`;
    }

    // -- Entity query -----------------------------------------------------

    async find(filter?: Record<string, unknown>): Promise<SerializedEntityData[]> {
        const url = new URL(this._projectUrl('/entities'));
        if (filter) {
            for (const [key, value] of Object.entries(filter)) {
                if (value !== undefined) {
                    url.searchParams.set(key, String(value));
                }
            }
        }
        const response = await fetch(url, {
            method: 'GET',
            headers: this._headers(),
            cache: 'no-store',
        });
        if (!response.ok) {
            throw new Error(`Failed to find entities (${response.status} ${response.statusText})`);
        }
        const payload = await response.json() as { entities?: SerializedEntityData[] };
        return payload.entities ?? [];
    }

    // -- Changes exchange -------------------------------------------------

    async applyDelta(deltaData: DeltaData): Promise<void> {
        const body: Record<string, unknown> = { delta: deltaData };
        const response = await fetch(this._projectUrl('/changes'), {
            method: 'POST',
            headers: { ...this._headers(), 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            throw new Error(`Failed to apply delta (${response.status} ${response.statusText})`);
        }
    }
}
