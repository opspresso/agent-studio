export interface McpServer {
  name: string;
  url: string;
  description?: string;
  /** Values encrypted at rest (enc:v1: prefix); masked with length-preserving asterisks on client reads. */
  headers: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}
