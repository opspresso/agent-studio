import type { Workspace, RuntimeSession, WorkspaceInput, WorkspaceEventData } from "./types";

export interface SandboxCommand {
  argv: string[];
  cwd?: string;
  stdin?: string;
  timeoutMs: number;
}

export interface SandboxCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SandboxOperation {
  id: string;
  status: "running" | "succeeded" | "failed" | "missing";
  exitCode?: number;
}

/** A provider owns compute and files, not agents, Git publication, or approvals. */
export interface SandboxProvider {
  readonly kind: string;
  ensure(workspaceId: string): Promise<{ externalId: string }>;
  inspect(externalId: string): Promise<"ready" | "missing" | "stopped">;
  execute(externalId: string, command: SandboxCommand): Promise<SandboxCommandResult>;
  start(externalId: string, operationId: string, command: SandboxCommand): Promise<void>;
  operation(externalId: string, operationId: string): Promise<SandboxOperation>;
  output(externalId: string, operationId: string, offset: number): Promise<{ text: string; nextOffset: number }>;
  cancel(externalId: string, operationId: string): Promise<void>;
  checkpoint(externalId: string): Promise<Uint8Array>;
  restore(externalId: string, checkpoint: Uint8Array): Promise<void>;
  destroy(externalId: string): Promise<void>;
}

/** Native session history stays native; each runtime translates only its transport events. */
export interface WorkspaceRuntimeAdapter {
  readonly kind: RuntimeSession["runtime"];
  command(workspace: Workspace, session: RuntimeSession, input: WorkspaceInput, timeoutMs: number): SandboxCommand;
  events(line: string): WorkspaceEventData[];
}

export interface WorkspaceCheckpointStore {
  put(workspaceId: string, checkpointId: string, bytes: Uint8Array, createdAt: string): Promise<void>;
  get(workspaceId: string, checkpointId: string): Promise<Uint8Array | null>;
  delete(workspaceId: string): Promise<void>;
}
