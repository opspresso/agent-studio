import type { DocumentRenderer, DocumentEditor } from "@/domain/document/processor";
import type { RegisterMcpSource } from "@/application/audio/mapMcpSource";
import type { FileToolDeps } from "@/application/document/fileTool";
/**
 * Types the execution facade exposes, plus the Agent → engine parameter
 * mapping every runner shares. Separate from the entry points so the modules
 * below can use them without importing the facade itself.
 */

import type { CatalogSearchDeps } from "@/application/catalog/searchCatalog";
import type { ModelProvider } from "@openai/agents";
import type { ToolSchemaValidator } from "@/domain/llm/toolSchema";
import type { ChatMessageInput, EngineParameters, McpToolResult } from "@/domain/llm/types";
import type { McpRepository } from "@/domain/mcp/repository";
import type { AgentRepository } from "@/domain/agent/repository";
import type { Agent, AgentConfiguration, McpBinding } from "@/domain/agent/types";
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
  getCallRoutingPolicy?: () => Promise<import("@/domain/llm/callRouting").CallRoutingPolicy>;
  callRouting?: import("@/application/llm/callModelRouter").CallRoutingDeps;
  createToolSchemaValidator: () => ToolSchemaValidator;
  runtimeSessions?: RuntimeSessionServices;
  agents: AgentRepository;
  skills: SkillRepository;
  mcps: McpRepository;
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
  audioTools?: (agentName: string, origin: RunOrigin) => Promise<
    ((tool: string, args: Record<string, unknown>) => Promise<McpToolResult>) | undefined
  >;
  workspaceTool?: (agentName: string, origin: RunOrigin) => Promise<
    ((args: Record<string, unknown>, callId: string) => Promise<McpToolResult>) | undefined
  >;
  registerMcpSource?: RegisterMcpSource;
  sourceRefreshIdentity?(input: { configuration: AgentConfiguration; binding: McpBinding; server: McpServer }): Promise<string>;
  /**
   * A reader for the Slack workspace this agent's bot is installed in, or
   * null when it has no enabled bot.
   *
   * Bound by the composition root rather than assembled here, and that is the
   * layering rather than a preference: *which token an agent reads with* is
   * the Slack slice's knowledge, and reaching for it from execution makes the
   * two slices mutually dependent — the Slack slice already names this one to
   * describe the runs it starts. The usage slice takes its profile reader the
   * same way, for the same reason.
   */
  slackWorkspace: (agent: Agent) => SlackWorkspaceReader | null;
  /** MCP tool sessions — wired by the composition root; tests inject a fake. */
  mcpSessions: McpSessionFactory;
  /** Per-agent OAuth for registry servers that require it. */
  mcpAuth: McpAuthProvider;
  /**
   * Which registry servers this agent has an OAuth connection to.
   *
   * Read-only, and separate from {@link mcpAuth} on purpose: resolving headers
   * refreshes tokens, while capability discovery only needs to know whether a
   * connection exists before it offers a server it never bound. Absent means
   * discovery cannot tell, and treats every OAuth server as unconnected.
   */
  mcpConnections?: Pick<McpConnectionRepository, "listByAgent">;
  /**
   * The global capability catalog, when this deployment has one. Absent means
   * an Agent's `dynamicCapabilities` has nothing to search and the run offers
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
  agent: Agent;
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
  signal?: AbortSignal;
}

// --- Agent-level dispatch --------------------------------------------------

export interface AgentRunInput {
  backgroundTask?: boolean;
  agent: Agent;
  configuration: AgentConfiguration;
  messages: ChatMessageInput[];
  actor?: RunActor;
  /** Server-resolved user identity for non-user entry points such as schedules. */
  ownerEmail?: string;
  /** See {@link ExecuteAgentInput.caller}. */
  caller?: RunCaller;
  /** See {@link ExecuteAgentInput.conversation}. */
  conversation?: RunConversation;
  signal?: AbortSignal;
}

/**
 * The caller the prompt is allowed to name — the Agent's opt-in decides, not
 * the surface. A surface that resolved one anyway (a cached profile, a replayed
 * run) must not be able to leak a name into an Agent that never asked for it.
 *
 * Here rather than beside the runners because the Playground preview asks the
 * same question. One shared gate keeps prompt and agent previews aligned.
 */
export function callerFor(input: { configuration: AgentConfiguration; caller?: RunCaller }): { caller?: RunCaller } {
  return input.configuration.parameters.callerContext && input.caller ? { caller: input.caller } : {};
}

/** Forward surface context unchanged; callerFor owns the prompt's identity opt-in. */
export function toRunInput(
  input: AgentRunInput,
): Pick<
  ExecuteAgentInput,
  "agent" | "configuration" | "messages" | "actor" | "caller" | "conversation" | "signal" | "ownerEmail" | "backgroundTask"
> {
  return {
    agent: input.agent,
    configuration: input.configuration,
    messages: input.messages,
    ...(input.actor ? { actor: input.actor } : {}),
    ...(input.caller ? { caller: input.caller } : {}),
    ...(input.conversation ? { conversation: input.conversation } : {}),
    ...(input.ownerEmail ? { ownerEmail: input.ownerEmail } : {}),
    ...(input.backgroundTask ? { backgroundTask: true } : {}),
    signal: input.signal,
  };
}

// --- Prompt preview ---------------------------------------------------------

export interface PromptPreviewMessage {
  role: "system" | "user";
  content: string;
}

export interface PromptPreview {
  /** The messages this Agent would open a run with. */
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
   * Capabilities a search added on top of the Agent's bindings, by name.
   *
   * Separate from `warnings` because it is the opposite of one, and this panel
   * is the only place an author can read it: the prompt above shows the widened
   * result without saying which rows the Agent never bound.
   */
  discovered: string[];
}

export function toEngineParameters(configuration: AgentConfiguration): EngineParameters {
  const p = configuration.parameters;
  const params: EngineParameters = {};
  if (p.modelRouting !== undefined) params.modelRouting = p.modelRouting;
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
