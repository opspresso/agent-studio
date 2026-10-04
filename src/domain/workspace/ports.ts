import type { Workspace, RuntimeSession, WorkspaceInput, WorkspaceEventData } from "./types";

/** Admission rejected before any compute was allocated; retrying cannot replay work. */
export class SandboxCapacityUnavailableError extends Error {
  constructor() { super("Sandbox capacity is full"); this.name = "SandboxCapacityUnavailableError"; }
}

export interface SandboxCommand {
  argv: string[];
  cwd?: string;
  stdin?: string;
  /** Deployment-owned model settings only; never host environment inheritance. */
  environment?: Record<string, string>;
  timeoutMs: number;
}

export interface SandboxCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SandboxOperation {
  id: string;
  status: "not-started" | "starting" | "running" | "succeeded" | "failed" | "missing";
  exitCode?: number;
  /** Provider log bytes were permanently omitted, rather than awaiting another output page. */
  truncated?: boolean;
}

export interface SandboxOutput {
  frames: { stream: "stdout" | "stderr"; text: string }[];
  nextOffset: number;
}

/** A provider owns compute and files, not agents, Git publication, or approvals. */
export interface SandboxProvider {
  readonly kind: string;
  ensure(workspaceId: string): Promise<{ externalId: string }>;
  /** Allocate before waiting for readiness so a worker can durably track and cancel cold cluster provisioning. */
  provision?(workspaceId: string): Promise<{ externalId: string }>;
  inspect(externalId: string): Promise<"ready" | "missing" | "stopped" | "provisioning">;
  execute(externalId: string, command: SandboxCommand): Promise<SandboxCommandResult>;
  start(externalId: string, operationId: string, command: SandboxCommand): Promise<void>;
  operation(externalId: string, operationId: string): Promise<SandboxOperation>;
  output(externalId: string, operationId: string, offset: number): Promise<SandboxOutput>;
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
  /** Remove a bounded batch of superseded snapshots while the caller still owns the current checkpoint and lease. */
  prune(workspaceId: string, checkpointId: string, leaseToken: string): Promise<number>;
  delete(workspaceId: string): Promise<void>;
}
