/** Externally registered agent, usable as a `type: "remote"` subagent. */
export interface ExternalAgent {
  name: string;
  /** OpenAI-compatible chat completions endpoint or agent endpoint. */
  url: string;
  description: string;
  /** Values encrypted at rest (enc:v1: prefix); masked as ******** on client reads. */
  headers: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}
