import type { ChatRepository } from "@/domain/chat/repository";
import type { ProjectRepository, VersionRepository } from "@/domain/project/repository";
import type { Project, Version } from "@/domain/project/types";
import type { ChatMessageInput, EngineChunk } from "@/domain/llm/types";

export interface AgentRunParams {
  project: Project;
  version: Version;
  /** OpenAI-shaped message history (see messageMapping.ts). */
  messages: ChatMessageInput[];
  userEmail: string;
}

/** Bound wrapper over `executeAgent(executionDeps, params)`, injected at the route boundary. */
export type AgentRunner = (params: AgentRunParams) => AsyncGenerator<EngineChunk>;

export interface ChatDeps {
  chats: ChatRepository;
  projects: ProjectRepository;
  versions: VersionRepository;
  runAgent: AgentRunner;
}
