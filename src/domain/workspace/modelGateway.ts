import type { UsageDelta } from "../usage/types";
import type { WorkspaceModelRuntime } from "./types";

/** Native CLI credentials authorize only one already admitted Workspace run. */
export interface WorkspaceModelClaims {
  workspaceId: string;
  runId: string;
  runtime: WorkspaceModelRuntime;
  model: string;
  expiresAt: number;
}
export interface WorkspaceModelTokens {
  issue(claims: WorkspaceModelClaims): string;
  verify(token: string, nowSeconds: number): WorkspaceModelClaims | null;
}
export interface NativeModelUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  costUsd?: number;
}
/** Unsettled calls survive a gateway/worker restart and are never sent upstream again. */
export interface WorkspaceModelCall {
  id: string;
  workspaceId: string;
  runId: string;
  startedAt: string;
  uncertain?: true;
  usage?: UsageDelta;
}
export interface WorkspaceModelCalls {
  /** One native inference request at a time per run, independent of Studio run slots. */
  begin(call: WorkspaceModelCall): Promise<boolean>;
  get(workspaceId: string, runId: string): Promise<WorkspaceModelCall | null>;
  capture(call: WorkspaceModelCall): Promise<void>;
  finish(call: WorkspaceModelCall): Promise<void>;
}
export type NativeModelProtocol = "responses" | "messages" | "chat/completions";
export interface WorkspaceModelTransport {
  forward(input: {
    model: string;
    protocol: NativeModelProtocol;
    body: Record<string, unknown>;
    countTokens?: boolean;
    headers: Record<string, string>;
    signal: AbortSignal;
    finish(usage: NativeModelUsage | undefined, complete: boolean): Promise<void>;
  }): Promise<Response>;
}
