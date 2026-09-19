import type { RunActor, RunCaller, RunConversation } from "@/domain/execution/actor";
import type { ChatRepository } from "@/domain/chat/repository";
import type { ChatRunLogRepository } from "@/domain/chat/runLog";
import type { ProjectRepository } from "@/domain/project/repository";
import type { Project, AgentConfiguration } from "@/domain/project/types";
import type { ChatMessageInput, EngineChunk } from "@/domain/llm/types";
import type { ArtifactStorage } from "@/application/artifact/storeArtifact";
import type { DocumentExtractor } from "@/domain/llm/documentExtractor";
import type { RuntimeSessionServices } from "@/application/runtime/session";
import type { RuntimeApprovalDecision } from "@/domain/execution/runtimeSession";

export interface AgentRunParams {
  resumeApproval?: { revision: number; decisions: RuntimeApprovalDecision[] };
  project: Project;
  configuration: AgentConfiguration;
  /** The new user input; persisted SDK Session supplies previous model turns. */
  messages: ChatMessageInput[];
  /** Who caused the run — always the chat's owner, since chats are private. */
  actor: RunActor;
  /**
   * That owner in words. Reaches the prompt only when the version opted into
   * `callerContext`; the facade applies that gate, not this boundary.
   */
  caller?: RunCaller;
  /** The chat itself: `chat:{chatId}`, so a transfer or an MCP server can tell it apart from the owner's other chats. */
  conversation: RunConversation;
  signal?: AbortSignal;
}

/** Bound wrapper over `executeAgent(executionDeps, params)`, injected at the route boundary. */
export type AgentRunner = (params: AgentRunParams) => AsyncGenerator<EngineChunk>;

/** An image the user attached to a turn, as inline bytes. */
export interface AttachedImage {
  b64: string;
  mimeType: string;
}

/**
 * A document the user attached to a turn, as inline bytes. The name comes with
 * it because it is both what the reader sees and, for a file whose declared type
 * is `application/octet-stream`, the only thing that says what it is.
 */
export interface AttachedDocumentInput {
  b64: string;
  mimeType: string;
  name: string;
}

export interface ChatDeps {
  /** Persist cleanup intent before removing the chat; native compute is owned by Workspace. */
  closeWorkspace?: (chatId: string, ownerEmail: string) => Promise<void>;
  runtimeSessions?: RuntimeSessionServices;
  chats: ChatRepository;
  /**
   * Where a run writes itself down once its reader leaves. Required, not
   * optional: an unwired deployment would lose every resume silently, and a
   * chat that cannot be picked back up is exactly what this exists to fix.
   */
  runLog: ChatRunLogRepository;
  projects: ProjectRepository;
  runAgent: AgentRunner;
  /**
   * Where a chat's images are kept, and where its stored keys are signed for
   * reading. Unset skips persistence — images then render only during the live
   * stream.
   *
   * One field rather than the store-and-signer pair it replaces: those had to be
   * wired together (a stored key with no signer is an image nothing can display)
   * and only a comment on the composition site said so.
   */
  artifacts?: ArtifactStorage;
  /** Reads an attached document into the text the turn carries and stores. */
  documents: DocumentExtractor;
}
