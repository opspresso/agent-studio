import type { CodingApproval } from "@/domain/coding/types";
import type { Chat, AssistantChatMessage } from "@/domain/chat/types";
import type { Workspace, RuntimeSession, Sandbox, WorkspaceRun, WorkspaceEvent } from "./types";
import type { WorkspaceContinuation } from "./continuation";

export interface WorkspaceWrite {
  /** An owner deleting its Chat may schedule cleanup of an already closed Workspace. */
  deleteOwner?: string;
  workspace: Workspace;
  expectedRevision: number;
  session?: RuntimeSession;
  sandbox?: Sandbox;
  run?: WorkspaceRun;
  approval?: CodingApproval;
  events?: WorkspaceEvent[];
  /** Unique admission receipt, stored atomically with the queued run. */
  request?: { key: string; fingerprint: string; runId: string };
  delivery?: { id: string; fingerprint: string };
  /** Explicit owner follow-up may reopen a finished workspace; worker writes never set this. */
  reopenOwner?: string;
  /** Owner-requested Git review can restore a finished Workspace under an action lease. */
  reopenGitOwner?: string;
}

export interface WorkspaceRepository {
  create(workspace: Workspace, session: RuntimeSession, chat?: Chat, sourceChatId?: string): Promise<void>;
  /** Select an existing owned Workspace with a CAS on the source chat's project binding. */
  linkChat(workspace: Workspace, sourceChatId: string, expectedWorkspaceId?: string): Promise<void>;
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
  delivery(workspaceId: string, id: string): Promise<string | null>;
  dueContinuations(now: string, limit: number): Promise<WorkspaceContinuation[]>;
  continuation(workspaceId: string, approvalId: string): Promise<WorkspaceContinuation | null>;
  /** Compare-and-swap a notification; a claimed notification is never replayed. */
  updateContinuation(next: WorkspaceContinuation, expectedRevision: number, notice?: AssistantChatMessage): Promise<boolean>;
}
