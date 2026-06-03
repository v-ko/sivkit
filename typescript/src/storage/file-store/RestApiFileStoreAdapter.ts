import { FileStoreAdapter, AddFileResult } from "./FileStoreAdapter";
import { buildRestApiAuthHeaders, RestApiAuthConfig } from "../rest-api/Auth";

export class RestApiFileStoreAdapter implements FileStoreAdapter {
  private _userId: string;
  private _projectId: string;
  private _baseUrl: string;
  private _auth: RestApiAuthConfig;

  constructor(userId: string, projectId: string, baseUrl: string, auth: RestApiAuthConfig) {
    this._userId = userId;
    this._projectId = projectId;
    this._baseUrl = baseUrl;
    this._auth = auth;
  }

  private _url(path: string): string {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${this._baseUrl}/${encodeURIComponent(this._userId)}/${encodeURIComponent(this._projectId)}${normalizedPath}`;
  }

  private _headers(): HeadersInit {
    return buildRestApiAuthHeaders(this._auth);
  }

  async addFile(blob: Blob, path: string): Promise<AddFileResult> {
    const form = new FormData();
    const filename = path.split(/[\\/]/).pop() || 'file';
    form.append('file', blob, filename);

    // Encode path segments individually for the URL
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const url = this._url(`/files/${encodedPath}`);
    const response = await fetch(url, {
      method: 'POST',
      body: form,
      headers: this._headers(),
    });
    if (!response.ok) {
      throw new Error(`Failed to upload file: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();
    return { hash: result.hash, path: result.path };
  }

  async getFile(path: string): Promise<Blob> {
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const url = this._url(`/files/${encodedPath}`);
    const response = await fetch(url, { headers: this._headers(), cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Failed to fetch file: ${response.status} ${response.statusText}`);
    }
    return await response.blob();
  }

  async removeFile(path: string): Promise<void> {
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const url = this._url(`/files/${encodedPath}`);
    const response = await fetch(url, { method: 'DELETE', headers: this._headers() });
    if (!response.ok) {
      throw new Error(`Failed to remove file: ${response.status} ${response.statusText}`);
    }
  }

  async eraseStorage(): Promise<void> {
    // RestApi adapter does not own persistent storage — nothing to erase.
  }
}
