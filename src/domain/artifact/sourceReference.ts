import type { McpSourceMapping } from "@/domain/mcp/sourceMapping";

export interface SourceRefresh {
  /** Agent owning the MCP binding and OAuth connection, independent of artifact ownership. */
  agentName?: string;
  serverName: string;
  mapping: McpSourceMapping;
  /** Fingerprint of the endpoint, binding and connection generation, excluding rotated OAuth tokens. */
  identity: string;
}

export interface SourceReference {
  id: string;
  agentName: string;
  userEmail: string;
  /** Stable external identity, independent of a temporary signed URL. */
  namespace: string;
  itemId: string;
  filename: string;
  mimeType: string;
  encryptedUrl: string;
  createdAt: string;
  expiresAt: number;
  refresh?: SourceRefresh;
}

export interface SourceReferenceRepository {
  put(reference: SourceReference): Promise<void>;
  get(id: string): Promise<SourceReference | null>;
}

export interface SourceByteStream extends AsyncIterable<Uint8Array> {
  /** Release an opened source even if the destination rejects it before iteration. */
  close?(): Promise<void>;
}

export interface SourceDownloader {
  open(url: string, signal: AbortSignal, maxBytes: number): Promise<{ body: SourceByteStream; mimeType: string }>;
}
