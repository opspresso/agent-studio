/** Externally registered agent, usable as a `type: "remote"` subagent. */
export interface ExternalAgent {
  name: string;
  /** OpenAI-compatible chat completions endpoint. */
  url: string;
  description: string;
  /** Values encrypted at rest (enc:v1: prefix); masked on client reads (length-preserving; four visible characters at each end above eight characters). */
  headers: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}
