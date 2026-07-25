export interface McpServer {
  name: string;
  url: string;
  /**
   * One-line summary. This is the only field the engine shows the model — it
   * becomes a row in the system prompt's "Connected MCP Servers" table
   * (`mcpSystemPromptAddition`), so it must stay single-line or the markdown
   * table breaks.
   */
  description?: string;
  /**
   * Operator notes in markdown (setup steps, caveats, links). Console-only:
   * never sent to the model, unlike a skill's content.
   */
  content?: string;
  /** Values encrypted at rest (enc:v1: prefix); masked on client reads (length-preserving; long values reveal first/last 2 chars). */
  headers: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}
