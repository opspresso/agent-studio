import type { RunActor } from "@/domain/execution/actor";
import type { ChatRepository } from "@/domain/chat/repository";
import type { ProjectRepository, VersionRepository } from "@/domain/project/repository";
import type { Project, Version } from "@/domain/project/types";
import type { ChatMessageInput, EngineChunk } from "@/domain/llm/types";
import type { SignImageUrl } from "@/domain/chat/imageRefs";
import type { DocumentExtractor } from "@/domain/llm/documentExtractor";

export interface AgentRunParams {
  project: Project;
  version: Version;
  /** OpenAI-shaped message history (see messageMapping.ts). */
  messages: ChatMessageInput[];
  /** Who caused the run — always the chat's owner, since chats are private. */
  actor: RunActor;
  signal?: AbortSignal;
}

/** Bound wrapper over `executeAgent(executionDeps, params)`, injected at the route boundary. */
export type AgentRunner = (params: AgentRunParams) => AsyncGenerator<EngineChunk>;

/**
 * Upload a generated image and return its **object key**. Not a URL: the address
 * is signed at read time, so a stored transcript holds a reference rather than a
 * link that works forever.
 */
export type ImageStore = (image: { b64: string; mimeType: string }) => Promise<string>;

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
  chats: ChatRepository;
  projects: ProjectRepository;
  versions: VersionRepository;
  runAgent: AgentRunner;
  /** Unset skips image persistence — images then render only during the live stream. */
  storeImage?: ImageStore;
  /**
   * Signs a stored object key for reading. Set whenever `storeImage` is: without
   * it a new row's image cannot be displayed at all, while legacy public-URL rows
   * still can.
   */
  signImageUrl?: SignImageUrl;
  /** Reads an attached document into the text the turn carries and stores. */
  documents: DocumentExtractor;
}
