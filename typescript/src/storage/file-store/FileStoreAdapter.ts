export interface AddFileResult {
  hash: string;
  path: string;
}

export class FileExistsInPathError extends Error {
  constructor(path: string) {
    super(`File already exists at path: ${path}`);
    this.name = 'FileExistsInPathError';
  }
}

export interface FileStoreAdapter {
  addFile: (blob: Blob, path: string) => Promise<AddFileResult>;
  getFile: (path: string) => Promise<Blob>;
  removeFile: (path: string) => Promise<void>;
  eraseStorage: () => Promise<void>;
}
