/** Streaming source files are separate from generated artifacts and never have public URLs. */
export interface SourceObjectStore {
  write(input: {
    key: string;
    body: AsyncIterable<Uint8Array>;
    mimeType: string;
    maxBytes: number;
  }, signal?: AbortSignal): Promise<{ byteSize: number; checksum: string }>;
  read(key: string, maxBytes: number): Promise<{ bytes: Uint8Array; mimeType: string }>;
  stat(key: string): Promise<{ byteSize: number; mimeType: string; storedAt: string } | null>;
  delete(key: string): Promise<void>;
}

export class SourceObjectExistsError extends Error {
  constructor() { super("Source object already exists"); this.name = "SourceObjectExistsError"; }
}
