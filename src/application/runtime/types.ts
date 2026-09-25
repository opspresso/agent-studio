import type { ModelProvider, Session, AgentInputItem, RunState, Agent, AgentOutputType } from "@openai/agents";
import type { ChannelToolDef } from "@/domain/llm/channel";
import type { RunCaller } from "@/domain/execution/actor";
import type { ChatMessageInput, EngineParameters, McpToolResult } from "@/domain/llm/types";
import type { AgentCapabilityDeps, SkillInfo, SubagentInfo, McpServerInfo } from "@/application/llm/agentAssembly";
import type { RuntimeApproval, RuntimeApprovalDecision } from "@/domain/execution/runtimeSession";
import type { AgentConfiguration } from "@/domain/agent/types";
import type { PiiFilter } from "@/application/llm/pii";
import type { ImageHandle } from "@/application/llm/agentAssembly";
import type { TraceSpan } from "@/domain/trace/types";
import type { ToolSchemaValidator } from "@/domain/llm/toolSchema";

export type RecordUsageFn = (record: {
  agentName: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Cached prompt tokens, when the provider reported any (see `UsageInfo`). */
  cachedTokens?: number;
}) => Promise<void>;

export interface EngineDeps {
  onSdkSpan?: (span: TraceSpan) => void;
  channel: ModelProvider;
  recordUsage?: RecordUsageFn;
}

/**
 * The four injected abilities live in {@link AgentCapabilityDeps}
 * (`agentAssembly.ts`), because their *presence* is what the assembly derives
 * the prompt and tool set from; the MCP dispatcher stays here — it serves
 * calls, but which MCP tools are offered arrives as run input, not off a dep.
 */
export interface AgentDeps extends EngineDeps, AgentCapabilityDeps {
  /** Required whenever an agent exposes tools; text-only runs need no compiler. */
  createToolSchemaValidator?: () => ToolSchemaValidator;
  /** Dispatch an MCP tool by its (aliased) name. */
  callMcpTool?: (name: string, args: Record<string, unknown>) => Promise<McpToolResult>;
  loadAgent?: (name: string, request: AgentTask) => Promise<PreparedAgent>;
}

export interface AgentTask {
  message: string;
  images: Array<{ b64: string; mimeType: string }>;
  transcript?: string;
  signal?: AbortSignal;
  maxTurns?: number;
  invocationId?: string;
}

export interface PreparedAgent {
  input: RunAgentInput;
  deps: AgentDeps;
  warnings: string[];
  close: () => Promise<void>;
}

export interface RunAgentInput {
  runtime?: RuntimeTurnPersistence;
  agentName: string;
  model: string;
  fallbackModel?: string;
  systemPrompt?: string;
  messages: ChatMessageInput[];
  parameters?: EngineParameters;
  /** The run clock is injected; the runtime does not read wall-clock time. */
  now?: Date;
  /** The caller display identity, already gated by the Agent configuration. */
  caller?: RunCaller;
  /**
   * What the run recalled before this turn — the memory server's answer to the
   * newest user turn, already bounded. Handed in like the caller: the facade
   * asks, the engine tells the model. Absent keeps the prompt as it was.
   */
  remembered?: string;
  /**
   * Whether this run may fan out to several agents at once. Set by the top-level
   * execution facade only — a subagent run is never given the tool, so the number
   * of children a request can start does not grow with transfer depth.
   */
  canDispatch?: boolean;
  maxTurn?: number;
  skills?: SkillInfo[];
  subagents?: SubagentInfo[];
  /** MCP tool definitions, already aliased for name collisions. */
  mcpTools?: ChannelToolDef[];
  /** Per-server grouping of the MCP tools, for the system prompt overview. */
  mcpServers?: McpServerInfo[];
  signal?: AbortSignal;
}

export interface RuntimeAgentSnapshot {
  pii?: Array<[string, string]>;
  turn: number;
  resultChars: number;
  context?: { left: number; truncated: boolean };
  images: readonly ImageHandle[];
  resources?: { urls: number; files: number; imageTurn: number; imagesUsed: number };
}

export interface RuntimeGraphSnapshot {
  nextImageId?: number;
  delegations?: Array<{ scope: string; source: string; tool: string; id: string; args: string }>;
  agents: Record<string, RuntimeAgentSnapshot>;
  handoffs: Record<string, Array<{ source: string; tool: string; args: string }>>;
  identifiers: Record<string, { prefix?: string; used: string[] }>;
}

export interface RuntimeCheckpoint {
  previousImageIds?: string[];
  graph: RuntimeGraphSnapshot;
  status: "pending" | "running";
  state: string;
  approvals: RuntimeApproval[];
  input: Omit<RunAgentInput, "signal" | "runtime" | "now"> & { now?: string };
  configuration: AgentConfiguration;
  pii: Array<[string, string]>;
  bindings: Record<string, string>;
  previousItemCount: number;
}

export interface RuntimeTurnPersistence {
  nextImageId?: number;
  session: Session;
  filter?: PiiFilter;
  checkpoint?: RuntimeCheckpoint;
  decisions?: RuntimeApprovalDecision[];
  warnings: string[];
  images: ImageHandle[];
  checkBinding(key: string, fingerprint: string): void;
  commit(input: RunAgentInput, state: Pick<RunState<unknown, Agent<unknown, AgentOutputType>>, "getInterruptions" | "toString">, history: AgentInputItem[], graph: RuntimeGraphSnapshot): Promise<RuntimeApproval[]>;
}
