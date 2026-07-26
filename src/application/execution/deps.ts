/**
 * Types the execution facade exposes, plus the version → engine parameter
 * mapping every runner shares. Separate from the entry points so the modules
 * below can use them without importing the facade itself.
 */

import type { ExternalAgentRepository } from "@/domain/agent/repository";
import type { RemoteAgentDispatcher } from "@/domain/agent/dispatcher";
import type { LlmChannel } from "@/domain/llm/channel";
import type { ChatMessageInput, EngineChunk, EngineParameters, RunResult } from "@/domain/llm/types";
import type { McpRepository } from "@/domain/mcp/repository";
import type { ProjectRepository, VersionRepository } from "@/domain/project/repository";
import type { Project, SubagentRef, Version } from "@/domain/project/types";
import type { SkillRepository } from "@/domain/skill/repository";
import type { UsageRepository } from "@/domain/usage/repository";
import type { TraceRepository } from "@/domain/trace/repository";
import type { ImageBytes, ImageChannel } from "@/domain/llm/imageChannel";
import type { McpServerConfig, McpSessionFactory } from "@/domain/mcp/toolSession";
import { BlockedUrlError, type UrlPolicy } from "@/domain/security/urlPolicy";
import type { SecretCipher } from "@/domain/security/secretCipher";

export interface ExecutionDeps {
  versions: VersionRepository;
  projects: ProjectRepository;
  skills: SkillRepository;
  mcps: McpRepository;
  externalAgents: ExternalAgentRepository;
  usage: UsageRepository;
  /** LLM channel — wired by the composition root; tests inject a fake. */
  channel: LlmChannel;
  /** Image channel — wired by the composition root; tests inject a fake. */
  imageChannel: ImageChannel;
  /** Secret cipher — wired by the composition root; tests inject a fake. */
  cipher: SecretCipher;
  /** Outbound URL policy — wired by the composition root; tests inject a fake. */
  urlPolicy: UrlPolicy;
  /** External-agent dispatch — wired by the composition root; tests inject a fake. */
  remoteAgents: RemoteAgentDispatcher;
  /** MCP tool sessions — wired by the composition root; tests inject a fake. */
  mcpSessions: McpSessionFactory;
  traces?: TraceRepository;
  traceSampleRate?: number;
}

export interface ExecuteVersionInput {
  project: Project;
  version: Version;
  variables?: Record<string, string>;
  /** Prior OpenAI-shaped messages; `messages` is the route-layer alias. */
  extraMessages?: ChatMessageInput[];
  messages?: ChatMessageInput[];
  signal?: AbortSignal;
}

export interface ExecuteAgentInput {
  project: Project;
  version: Version;
  /** OpenAI-shaped message history from the route/chat boundary. */
  messages: ChatMessageInput[];
  userEmail?: string;
  signal?: AbortSignal;
}

// --- Project-level dispatch --------------------------------------------------

export interface ExecuteProjectInput {
  project: Project;
  version: Version;
  variables?: Record<string, string>;
  messages: ChatMessageInput[];
  userEmail?: string;
  signal?: AbortSignal;
}

// --- Prompt preview ---------------------------------------------------------

export interface PromptPreviewMessage {
  role: "system" | "user";
  content: string;
}

export interface PromptPreview {
  /** The messages this version would open a run with. */
  messages: PromptPreviewMessage[];
  /** Tool names the model would be offered, aliases applied. */
  toolNames: string[];
  /** What the preview — and therefore a run — could not resolve. */
  warnings: string[];
}

export function toEngineParameters(version: Version): EngineParameters {
  const p = version.parameters;
  const params: EngineParameters = {};
  if (p.temperature !== undefined) {
    params.temperature = p.temperature;
  }
  if (p.maxTokens !== undefined) {
    params.maxTokens = p.maxTokens;
  }
  if (p.reasoningEffort !== undefined) {
    params.reasoningEffort = p.reasoningEffort;
  }
  params.piiFiltering = p.piiFiltering;
  if (p.structuredOutput !== undefined) {
    params.structuredOutput = p.structuredOutput;
  }
  if (p.jsonSchema !== undefined) {
    params.jsonSchema = p.jsonSchema;
  }
  return params;
}
