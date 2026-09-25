import type { CodingRepository, PullRequestInfo } from "@/domain/coding/types";

export const WORKSPACE_RUNTIMES = ["command", "codex", "claude", "opencode"] as const;
export type WorkspaceRuntime = (typeof WORKSPACE_RUNTIMES)[number];
export type WorkspaceModelRuntime = Exclude<WorkspaceRuntime, "command">;
export type WorkspaceRuntimeModels = Partial<Record<WorkspaceModelRuntime, string>>;
export type WorkspaceStatus = "active" | "suspending" | "suspended" | "closing" | "closed";

/** Durable identity; a sandbox may be replaced without changing this or its session. */
export interface Workspace {
  id: string;
  chatId: string;
  ownerEmail: string;
  agentName: string;
  title: string;
  creationFingerprint?: string;
  runtime: WorkspaceRuntime;
  sessionId: string;
  status: WorkspaceStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  /** Scheduler deadline: queue, lease, idle TTL, or cleanup retry. */
  dueAt: string;
  idleTtlSeconds: number;
  leaseToken?: string;
  leaseUntil?: string;
  activeRunId?: string;
  activeActionId?: string;
  sandboxId?: string;
  checkpointId?: string;
  coding?: CodingRepository;
  pullRequest?: PullRequestInfo;
  /** Tombstone intent is durable before chat deletion and rejects new work. */
  deleteRequestedAt?: string;
  error?: string;
}

export interface Sandbox {
  id: string;
  workspaceId: string;
  provider: string;
  externalId: string;
  status: "provisioning" | "ready" | "deleting" | "deleted";
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeSession {
  id: string;
  workspaceId: string;
  runtime: WorkspaceRuntime;
  nativeSessionId?: string;
  createdAt: string;
  updatedAt: string;
}

export type WorkspaceInput =
  | { kind: "task"; prompt: string }
  | { kind: "command"; script: string };

export type WorkspaceRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";

export interface WorkspaceRun {
  id: string;
  workspaceId: string;
  sessionId: string;
  requestKey: string;
  input: WorkspaceInput;
  status: WorkspaceRunStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  leaseToken?: string;
  leaseUntil?: string;
  cancelRequestedAt?: string;
  /** An adapter operation handle is stable across worker restarts. */
  operationId?: string;
  outputOffset?: number;
  protocolBuffer?: string;
  phase?: "runtime" | "checks" | "checkpoint";
  checkIndex?: number;
  runtimeFailed?: boolean;
  lastEventSeq: number;
  exitCode?: number;
  error?: string;
  diff?: string;
  diffTruncated?: boolean;
  checks: WorkspaceCheck[];
}

export interface WorkspaceCheck {
  name: "test" | "lint" | "build";
  command: string;
  status: "pending" | "running" | "passed" | "failed" | "skipped";
  exitCode?: number;
  output: string;
  truncated?: boolean;
}

export type WorkspaceEventData =
  | { kind: "output"; stream: "stdout" | "stderr"; text: string }
  | { kind: "message"; text: string }
  | { kind: "session"; nativeSessionId: string }
  | { kind: "diff"; text: string; truncated: boolean }
  | { kind: "check"; check: WorkspaceCheck }
  | { kind: "status"; status: WorkspaceRunStatus; text?: string }
  | { kind: "warning"; text: string };

export interface WorkspaceEvent {
  workspaceId: string;
  runId: string;
  seq: number;
  createdAt: string;
  data: WorkspaceEventData;
}

export function isTerminalWorkspaceRun(status: WorkspaceRunStatus): boolean {
  return status !== "queued" && status !== "running";
}
