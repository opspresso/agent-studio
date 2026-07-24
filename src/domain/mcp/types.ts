export interface McpServer {
  name: string;
  url: string;
  description?: string;
  /** Values encrypted at rest (enc:v1: prefix); masked on client reads (length-preserving; long values reveal first/last 2 chars). */
  headers: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}
