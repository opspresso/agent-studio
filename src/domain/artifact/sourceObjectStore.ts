/** Streaming private Artifacts share the object store but never have public URLs. */
export interface SourceObjectStore {
  write(input: {
    key: string;
    body: AsyncIterable<Uint8Array>;
    mimeType: string;
    maxBytes: number;
  }, signal?: AbortSignal): Promise<{ byteSize: number; checksum: string }>;
  read(key: string, maxBytes: number, signal?: AbortSignal): Promise<{ bytes: Uint8Array; mimeType: string }>;
  stat(key: string, signal?: AbortSignal): Promise<{ byteSize: number; mimeType: string; storedAt: string } | null>;
  /** Removes source bytes and prevents delayed create-only writes from restoring them. */
  delete(key: string): Promise<void>;
}

export class SourceObjectExistsError extends Error {
  constructor() { super("Source object already exists"); this.name = "SourceObjectExistsError"; }
}
