import type { McpConnection } from "./connection";

export interface McpRefreshClaim {
  agentName: string;
  serverName: string;
  revision: string | undefined;
  owner: string;
  deadlineAt: string;
}
export type McpRefreshAdmission =
  | { kind: "claimed"; claim: McpRefreshClaim }
  | { kind: "pending"; deadlineAt: string }
  | { kind: "changed" }
  | { kind: "uncertain" };

/** A durable claim precedes the provider effect; an uncertain claim can never be replayed. */
export interface McpRefreshRepository {
  begin(connection: McpConnection, now: string, deadlineAt: string): Promise<McpRefreshAdmission>;
  finish(claim: McpRefreshClaim, outcome: "complete" | "uncertain"): Promise<void>;
}
