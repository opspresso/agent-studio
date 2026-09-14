import type { CodingApproval } from "@/domain/coding/types";
import type { Workspace, RuntimeSession, Sandbox, WorkspaceRun, WorkspaceEvent } from "./types";

export interface WorkspaceWrite {
  workspace: Workspace;
  expectedRevision: number;
  session?: RuntimeSession;
  sandbox?: Sandbox;
  run?: WorkspaceRun;
  approval?: CodingApproval;
  events?: WorkspaceEvent[];
  /** Unique admission receipt, stored atomically with the queued run. */
  request?: { key: string; fingerprint: string; runId: string };
}

export interface WorkspaceRepository {
  create(workspace: Workspace, session: RuntimeSession): Promise<void>;
  get(id: string): Promise<Workspace | null>;
  forChat(chatId: string): Promise<Workspace | null>;
  list(ownerEmail: string, limit: number): Promise<Workspace[]>;
  due(now: string, limit: number): Promise<Workspace[]>;
  /** Throws on a stale revision. All child writes share the workspace lifecycle fence. */
  write(change: WorkspaceWrite): Promise<void>;
  session(workspaceId: string, id: string): Promise<RuntimeSession | null>;
  sandbox(workspaceId: string, id: string): Promise<Sandbox | null>;
  run(workspaceId: string, id: string): Promise<WorkspaceRun | null>;
  runs(workspaceId: string, limit: number): Promise<WorkspaceRun[]>;
  events(workspaceId: string, runId: string, afterSeq: number, limit: number): Promise<WorkspaceEvent[]>;
  approval(workspaceId: string, id: string): Promise<CodingApproval | null>;
  approvals(workspaceId: string, limit: number): Promise<CodingApproval[]>;
  request(workspaceId: string, key: string): Promise<{ fingerprint: string; runId: string } | null>;
}
