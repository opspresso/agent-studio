import type { DocumentRenderer, DocumentEditor } from "@/domain/document/processor";
import type { RegisterMcpSource } from "@/application/audio/mapMcpSource";
import type { FileToolDeps } from "@/application/document/fileTool";
/**
 * Types the execution facade exposes, plus the version → engine parameter
 * mapping every runner shares. Separate from the entry points so the modules
 * below can use them without importing the facade itself.
 */

import type { CatalogSearchDeps } from "@/application/catalog/searchCatalog";
import type { ExternalAgentRepository } from "@/domain/agent/repository";
import type { RemoteAgentDispatcher } from "@/domain/agent/dispatcher";
import type { RemoteConversationRepository } from "@/domain/agent/remoteConversation";
import type { ModelProvider } from "@openai/agents";
import type { ToolSchemaValidator } from "@/domain/llm/toolSchema";
import type { ChannelToolDef } from "@/domain/llm/channel";
import type { ChatMessageInput, EngineParameters, McpToolResult } from "@/domain/llm/types";
import type { McpRepository } from "@/domain/mcp/repository";
import type { ProjectRepository } from "@/domain/project/repository";
import type { Project, AgentConfiguration, McpBinding } from "@/domain/project/types";
import type { McpServer } from "@/domain/mcp/types";
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
import type { RunActor, RunCaller, RunConversation, RunOrigin } from "@/domain/execution/actor";
import type { RunBracketDeps } from "@/application/run/runBracket";
import type { SlackWorkspaceReader } from "@/domain/slack/reader";
import type { RuntimeSessionServices } from "@/application/runtime/session";
import type { RuntimeApprovalDecision } from "@/domain/execution/runtimeSession";

/**
 * Extends the run bracket's deps rather than restating them: every entry point
 * in this facade opens a bracket, so anything the bracket needs is something
 * this bag must carry. Growing the bracket becomes a type error here instead of
 * a policy that silently stops applying to text runs.
 */
export interface ExecutionDeps extends RunBracketDeps {
  createToolSchemaValidator: () => ToolSchemaValidator;
  runtimeSessions?: RuntimeSessionServices;
  projects: ProjectRepository;
  skills: SkillRepository;
  mcps: McpRepository;
  externalAgents: ExternalAgentRepository;
  usage: UsageRepository;
  /** LLM channel — wired by the composition root; tests inject a fake. */
  channel: ModelProvider;
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
  readPrivateArtifact?: FileToolDeps["readPrivateArtifact"];
  documentRenderer?: DocumentRenderer;
  documentEditor?: DocumentEditor;
  audioTools?: (projectName: string, origin: RunOrigin) => Promise<
    ((tool: string, args: Record<string, unknown>) => Promise<McpToolResult>) | undefined
  >;
  workspaceTool?: (projectName: string, origin: RunOrigin) => Promise<
    ((args: Record<string, unknown>, callId: string) => Promise<McpToolResult>) | undefined
  >;
  registerMcpSource?: RegisterMcpSource;
  sourceRefreshIdentity?(input: { configuration: AgentConfiguration; binding: McpBinding; server: McpServer }): Promise<string>;
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
   * a deployment without it loses only continuity: every transfer is a cold start.
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
  /**
   * The wall clock a run's prompt is stamped with. Injected for the same reason
   * the channel is — a test that asserts on a prompt needs a fixed instant.
   * Unset means the real clock (see {@link runClock}).
   */
  now?: () => Date;
}

export interface ExecuteAgentInput {
  resumeApproval?: { revision: number; decisions: RuntimeApprovalDecision[] };
  backgroundTask?: boolean;
  project: Project;
  configuration: AgentConfiguration;
  /** OpenAI-shaped message history from the route/chat boundary. */
  messages: ChatMessageInput[];
  actor?: RunActor;
  /** Display identity, included only when callerContext is enabled. */
  caller?: RunCaller;
  /** Surface-scoped conversation identity. */
  conversation?: RunConversation;
  /**
   * Which user this run belongs to when the surface resolves an address the
   * actor does not carry — a Slack actor is a workspace id. It addresses the
   * output gallery and user-authorized MCP requests.
   *
   * Separate from {@link actor} on purpose: that key groups usage by surface and
   * decides which tier's spend cap and concurrency limit apply, and folding a
   * mailbox into it would answer a different question than the one this asks.
   */
  ownerEmail?: string;
  /** Tools the calling application executes on its side — see the engine's `RunAgentInput.clientTools`. */
  clientTools?: ChannelToolDef[];
  signal?: AbortSignal;
}

// --- Project-level dispatch --------------------------------------------------

export interface ExecuteProjectInput {
  backgroundTask?: boolean;
  project: Project;
  configuration: AgentConfiguration;
  variables?: Record<string, string>;
  messages: ChatMessageInput[];
  actor?: RunActor;
  /** Server-resolved user identity for non-user entry points such as schedules. */
  ownerEmail?: string;
  /** See {@link ExecuteAgentInput.caller}. */
  caller?: RunCaller;
  /** See {@link ExecuteAgentInput.conversation}. */
  conversation?: RunConversation;
  /**
   * See {@link ExecuteAgentInput.clientTools}. Reaches the agent loop only: a
   * single-shot run has no loop to end, and an image run no model to offer
   * them to — a surface with tools to declare checks the strategy first.
   */
  clientTools?: ChannelToolDef[];
  signal?: AbortSignal;
}

/**
 * The caller the prompt is allowed to name — the version's opt-in decides, not
 * the surface. A surface that resolved one anyway (a cached profile, a replayed
 * run) must not be able to leak a name into a version that never asked for it.
 *
 * Here rather than beside the runners because the Playground preview asks the
 * same question. One shared gate keeps prompt and agent previews aligned.
 */
export function callerFor(input: { configuration: AgentConfiguration; caller?: RunCaller }): { caller?: RunCaller } {
  return input.configuration.parameters.callerContext && input.caller ? { caller: input.caller } : {};
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
  "project" | "configuration" | "messages" | "actor" | "caller" | "conversation" | "clientTools" | "signal" | "ownerEmail" | "backgroundTask"
> {
  return {
    project: input.project,
    configuration: input.configuration,
    messages: input.messages,
    ...(input.actor ? { actor: input.actor } : {}),
    ...(input.caller ? { caller: input.caller } : {}),
    ...(input.conversation ? { conversation: input.conversation } : {}),
    ...(input.ownerEmail ? { ownerEmail: input.ownerEmail } : {}),
    ...(input.backgroundTask ? { backgroundTask: true } : {}),
    ...(input.clientTools ? { clientTools: input.clientTools } : {}),
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

export function toEngineParameters(configuration: AgentConfiguration): EngineParameters {
  const p = configuration.parameters;
  const params: EngineParameters = {};
  if (p.policy) params.policy = p.policy;
  if (p.temperature !== undefined) {
    params.temperature = p.temperature;
  }
  if (p.presencePenalty !== undefined) {
    params.presencePenalty = p.presencePenalty;
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
  if (p.reasoningTrace !== undefined) {
    params.reasoningTrace = p.reasoningTrace;
  }
  return params;
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
