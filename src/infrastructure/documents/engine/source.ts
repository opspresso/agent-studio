/** Bytes and provenance supplied by the caller; the engine performs no I/O. */
export interface DocumentSource {
  bytes: Uint8Array;
  mimeType: string;
  label: string;
  filename?: string;
}
