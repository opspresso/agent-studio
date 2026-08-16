/**
 * Types the execution facade exposes, plus the version → engine parameter
 * mapping every runner shares. Separate from the entry points so the modules
 * below can use them without importing the facade itself.
 */

import type { CatalogSearchDeps } from "@/application/catalog/searchCatalog";
import type { ExternalAgentRepository } from "@/domain/agent/repository";
import type { RemoteAgentDispatcher } from "@/domain/agent/dispatcher";
import type { RemoteConversationRepository } from "@/domain/agent/remoteConversation";
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
import type { McpConnectionRepository } from "@/domain/mcp/connection";
import type { UrlPolicy } from "@/domain/security/urlPolicy";
import type { HttpResourceReader } from "@/domain/net/httpResource";
import type { DocumentExtractor } from "@/domain/llm/documentExtractor";
import type { SecretCipher } from "@/domain/security/secretCipher";
import type { RunActor, RunCaller, RunConversation } from "@/domain/execution/actor";
import type { RunBracketDeps } from "@/application/run/runBracket";
import type { SlackWorkspaceReader } from "@/domain/slack/reader";

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
  /**
   * Reads an address the model named — wired by the composition root; tests
   * inject a fake. Required rather than optional: an optional port that nobody
   * wired looks exactly like a feature that is switched off.
   */
  http: HttpResourceReader;
  /** Turns attached or fetched bytes into text; tests inject a fake. */
  documents: DocumentExtractor;
  /**
   * A reader for the Slack workspace this project's bot is installed in, or
   * null when it has no enabled bot.
   *
   * Bound by the composition root rather than assembled here, and that is the
   * layering rather than a preference: *which token a project reads with* is
   * the Slack slice's knowledge, and reaching for it from execution makes the
   * two slices mutually dependent — the Slack slice already names this one to
   * describe the runs it starts. The usage slice takes its profile reader the
   * same way, for the same reason.
   */
  slackWorkspace: (project: Project) => SlackWorkspaceReader | null;
  /** External-agent dispatch — wired by the composition root; tests inject a fake. */
  remoteAgents: RemoteAgentDispatcher;
  /**
   * Which remote conversation an external agent holds for one of ours, so a
   * second transfer from the same conversation continues it. Optional because
   * a deployment without it loses only continuity: every transfer is then a
   * cold start, which is what every transfer was before this existed.
   */
  remoteConversations?: RemoteConversationRepository;
  /** MCP tool sessions — wired by the composition root; tests inject a fake. */
  mcpSessions: McpSessionFactory;
  /** Per-project OAuth for registry servers that require it. */
  mcpAuth: McpAuthProvider;
  /**
   * Which registry servers this project has an OAuth connection to.
   *
   * Read-only, and separate from {@link mcpAuth} on purpose: resolving headers
   * refreshes tokens, while capability discovery only needs to know whether a
   * connection exists before it offers a server it never bound. Absent means
   * discovery cannot tell, and treats every OAuth server as unconnected.
   */
  mcpConnections?: Pick<McpConnectionRepository, "listByProject">;
  /**
   * The global capability catalog, when this deployment has one. Absent means
   * a version's `dynamicCapabilities` has nothing to search and the run offers
   * exactly what it bound — the feature is off rather than failing.
   */
  catalog?: CatalogSearchDeps;
  /**
   * DNS suffixes this deployment declared reachable despite resolving privately
   * (`config.mcpInternalHostSuffixes`). Injected rather than read here, because
   * the decision it feeds lives in the domain and the value lives in the
   * environment. Absent means the guard applies to everything, as before.
   */
  internalHostSuffixes?: readonly string[];
  traces?: TraceRepository;
  traceSampleRate?: number;
  /**
   * The wall clock a run's prompt is stamped with. Injected for the same reason
   * the channel is — a test that asserts on a prompt needs a fixed instant.
   * Unset means the real clock (see {@link runClock}).
   */
  now?: () => Date;
  /**
   * The draw the trace sampling decision compares against `traceSampleRate`,
   * in `[0, 1)`. Injected like {@link now} so a test can pin the outcome at a
   * fractional rate. Unset means `Math.random` (see `traceSampled`).
   */
  sample?: () => number;
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
  /**
   * Who that actor is, in words. Reaches the prompt only when the version opted
   * in (`parameters.callerContext`); the surface is expected not to resolve one
   * at all otherwise.
   */
  caller?: RunCaller;
  /** Which conversation this run belongs to, when the surface has one. */
  conversation?: RunConversation;
  signal?: AbortSignal;
}

export interface ExecuteAgentInput {
  project: Project;
  version: Version;
  /** OpenAI-shaped message history from the route/chat boundary. */
  messages: ChatMessageInput[];
  actor?: RunActor;
  /** See {@link ExecuteVersionInput.caller}. */
  caller?: RunCaller;
  /** See {@link ExecuteVersionInput.conversation}. */
  conversation?: RunConversation;
  /**
   * Whose gallery this run's output belongs in, when the surface can resolve an
   * address the actor does not carry — a Slack actor is a workspace id.
   *
   * Separate from {@link actor} on purpose: that key groups usage by surface and
   * decides which tier's spend cap and concurrency limit apply, and folding a
   * mailbox into it would answer a different question than the one this asks.
   */
  ownerEmail?: string;
  signal?: AbortSignal;
}

// --- Project-level dispatch --------------------------------------------------

export interface ExecuteProjectInput {
  project: Project;
  version: Version;
  variables?: Record<string, string>;
  messages: ChatMessageInput[];
  actor?: RunActor;
  /** See {@link ExecuteVersionInput.caller}. */
  caller?: RunCaller;
  /** See {@link ExecuteVersionInput.conversation}. */
  conversation?: RunConversation;
  signal?: AbortSignal;
}

/**
 * The caller the prompt is allowed to name — the version's opt-in decides, not
 * the surface. A surface that resolved one anyway (a cached profile, a replayed
 * run) must not be able to leak a name into a version that never asked for it.
 *
 * Here rather than beside the runners because the Playground preview asks the
 * same question, and it used to answer it with its own copy of the condition —
 * one that only ran on the agent branch, so a prompt project previewed
 * anonymously no matter what its version said.
 */
export function callerFor(input: { version: Version; caller?: RunCaller }): { caller?: RunCaller } {
  return input.version.parameters.callerContext && input.caller ? { caller: input.caller } : {};
}

/**
 * What the facade hands whichever executor it picked, projected in one place.
 *
 * Both dispatch points rebuilt this literal per branch — four copies of "which
 * fields travel down" — and every one of them omitted `caller`. Optional fields
 * make that a silent drop rather than a type error, so a version that opted into
 * `callerContext` ran anonymously through `/predict` and `/chat/completions`
 * while the same version named its caller on `/agent`, in a chat and in Slack,
 * all of which reach `executeAgent` directly. The gate itself is not applied
 * here: {@link callerFor} answers that once, at the engine-input boundary, and a
 * second gate on the way there could only disagree with it.
 *
 * `variables` is deliberately not part of this. It belongs to the single-shot
 * path — an agent run has no template to render with it — so that branch adds
 * it rather than every branch carrying a field one of them must ignore.
 */
export function toRunInput(
  input: ExecuteProjectInput,
): Pick<
  ExecuteAgentInput,
  "project" | "version" | "messages" | "actor" | "caller" | "conversation" | "signal"
> {
  return {
    project: input.project,
    version: input.version,
    messages: input.messages,
    ...(input.actor ? { actor: input.actor } : {}),
    ...(input.caller ? { caller: input.caller } : {}),
    ...(input.conversation ? { conversation: input.conversation } : {}),
    signal: input.signal,
  };
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
  /** Tool contracts the model would receive, aliases applied. */
  tools: Array<{
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  }>;
  /** What the preview — and therefore a run — could not resolve. */
  warnings: string[];
  /**
   * Capabilities a search added on top of the version's bindings, by name.
   *
   * Separate from `warnings` because it is the opposite of one, and this panel
   * is the only place an author can read it: the prompt above shows the widened
   * result without saying which rows the version never bound.
   */
  discovered: string[];
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
