/**
 * Types the execution facade exposes, plus the version → engine parameter
 * mapping every runner shares. Separate from the entry points so the modules
 * below can use them without importing the facade itself.
 */

import type { ExternalAgentRepository } from "@/domain/agent/repository";
import type { RemoteAgentDispatcher } from "@/domain/agent/dispatcher";
import type { LlmChannel } from "@/domain/llm/channel";
import type { ChatMessageInput, EngineParameters } from "@/domain/llm/types";
import type { McpRepository } from "@/domain/mcp/repository";
import type { ProjectRepository, VersionRepository } from "@/domain/project/repository";
import type { Project, Version } from "@/domain/project/types";
import type { SkillRepository } from "@/domain/skill/repository";
import type { UsageRepository } from "@/domain/usage/repository";
import type { TraceRepository } from "@/domain/trace/repository";
import type { ImageChannel } from "@/domain/llm/imageChannel";
import type { McpSessionFactory } from "@/domain/mcp/toolSession";
import type { McpAuthProvider } from "@/domain/mcp/oauth";
import type { UrlPolicy } from "@/domain/security/urlPolicy";
import type { SecretCipher } from "@/domain/security/secretCipher";
import type { RunActor } from "@/domain/execution/actor";
import type { RunBracketDeps } from "./runBracket";

/**
 * Extends the run bracket's deps rather than restating them: every entry point
 * in this facade opens a bracket, so anything the bracket needs is something
 * this bag must carry. Growing the bracket becomes a type error here instead of
 * a policy that silently stops applying to text runs.
 */
export interface ExecutionDeps extends RunBracketDeps {
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
  /** Per-project OAuth for registry servers that require it. */
  mcpAuth: McpAuthProvider;
  traces?: TraceRepository;
  traceSampleRate?: number;
  /**
   * The wall clock a run's prompt is stamped with. Injected for the same reason
   * the channel is — a test that asserts on a prompt needs a fixed instant.
   * Unset means the real clock (see {@link runClock}).
   */
  now?: () => Date;
}

export interface ExecuteVersionInput {
  project: Project;
  version: Version;
  variables?: Record<string, string>;
  /** Prior OpenAI-shaped messages; `messages` is the route-layer alias. */
  extraMessages?: ChatMessageInput[];
  messages?: ChatMessageInput[];
  /** Who caused this run. Recorded on the trace and on the caller's usage row. */
  actor?: RunActor;
  signal?: AbortSignal;
}

export interface ExecuteAgentInput {
  project: Project;
  version: Version;
  /** OpenAI-shaped message history from the route/chat boundary. */
  messages: ChatMessageInput[];
  actor?: RunActor;
  signal?: AbortSignal;
}

// --- Project-level dispatch --------------------------------------------------

export interface ExecuteProjectInput {
  project: Project;
  version: Version;
  variables?: Record<string, string>;
  messages: ChatMessageInput[];
  actor?: RunActor;
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

/** How a project is executed. */
export type RunStrategy = "image" | "agent" | "prompt";

/**
 * The single owner of "which project type runs which way".
 *
 * `executeProjectStream` already dispatches agent vs. single-shot internally,
 * but the image path returns a value rather than a stream, so callers had to
 * ask the question again — three of them did, each spelling out
 * `projectType === "image"` and `=== "agent"` for itself. Adding a fourth
 * project type meant finding all three. They now ask here and only decide how
 * to serialise the answer.
 */
export function runStrategyFor(project: Project): RunStrategy {
  if (project.projectType === "image") {
    return "image";
  }
  return project.projectType === "agent" ? "agent" : "prompt";
}

/**
 * The instant this run's prompt says it is happening.
 *
 * Read at the composition point, not in the engine: the engine takes the value
 * as input so it stays pure and its tests stay off the real clock. One call per
 * run, so every prompt a run assembles — including a subagent's — agrees on
 * when "now" is, and the Playground preview can report the same instant.
 */
export function runClock(deps: Pick<ExecutionDeps, "now">): Date {
  return deps.now?.() ?? new Date();
}
