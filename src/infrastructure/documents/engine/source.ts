/** Source bytes and provenance supplied by the caller; readers do not fetch remote files. */
export interface DocumentSource {
  bytes: Uint8Array;
  mimeType: string;
  label: string;
  filename?: string;
}
