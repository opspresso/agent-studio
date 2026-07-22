export type AgentProtocol = "openai" | "a2a";

/** Externally registered agent, usable as a `type: "remote"` subagent. */
export interface ExternalAgent {
  name: string;
  /**
   * OpenAI-compatible chat completions endpoint, or for `protocol: "a2a"`
   * the Agent Card URL (`.../.well-known/agent-card.json` or its base URL).
   */
  url: string;
  /** Wire protocol for dispatch. Absent means "openai" (pre-existing rows). */
  protocol?: AgentProtocol;
  description: string;
  /** Values encrypted at rest (enc:v1: prefix); masked with length-preserving asterisks on client reads. */
  headers: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}
