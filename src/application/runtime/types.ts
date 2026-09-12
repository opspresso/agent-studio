import type { ModelProvider, Session, AgentInputItem, RunState, Agent, AgentOutputType } from "@openai/agents";
import type { ChannelToolDef } from "@/domain/llm/channel";
import type { RunCaller } from "@/domain/execution/actor";
import type { ChatMessageInput, EngineChunk, EngineParameters, McpToolResult } from "@/domain/llm/types";
import type { AgentCapabilityDeps, SkillInfo, SubagentInfo, McpServerInfo } from "@/application/llm/agentAssembly";
import type { RuntimeApproval, RuntimeApprovalDecision } from "@/domain/execution/runtimeSession";
import type { Version } from "@/domain/project/types";
import type { PiiFilter } from "@/application/llm/pii";
import type { ImageHandle } from "@/application/llm/agentAssembly";
import type { TraceSpan } from "@/domain/trace/types";

export type RecordUsageFn = (record: {
  projectName: string;
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

export type PreparedAgent = {
  kind: "agent";
  input: RunAgentInput;
  deps: AgentDeps;
  warnings: string[];
  close: () => Promise<void>;
} | {
  kind: "action";
  run: () => AsyncGenerator<EngineChunk, string>;
};

export interface RunPromptInput {
  projectName?: string;
  model: string;
  fallbackModel?: string;
  systemPrompt?: string;
  userPromptTemplate: string;
  variables?: Record<string, string>;
  extraMessages?: ChatMessageInput[];
  parameters?: EngineParameters;
  /**
   * The run's wall clock, injected rather than read: the engine stays pure and
   * its tests stay off the real clock. Omitted leaves the prompt exactly as it
   * was before there was a clock.
   */
  now?: Date;
  /** Who is asking. Absent leaves the prompt exactly as it was without one. */
  caller?: RunCaller;
  signal?: AbortSignal;
}

export interface RunAgentInput {
  runtime?: RuntimeTurnPersistence;
  projectName: string;
  model: string;
  fallbackModel?: string;
  systemPrompt?: string;
  messages: ChatMessageInput[];
  parameters?: EngineParameters;
  /** See {@link RunPromptInput.now} — injected, never read from the clock here. */
  now?: Date;
  /** See {@link RunPromptInput.caller}. */
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
  /** Starting turn, used when a subagent continues the parent's turn budget. */
  startTurn?: number;
  /**
   * The conversation to hand to anything this run transfers to. Set by a
   * subagent runner so the *original* chat travels down the whole chain: a
   * child's own `messages` are the one synthetic turn it was handed, and
   * deriving from those would nest each hop's transcript inside the next.
   */
  transcript?: string;
  skills?: SkillInfo[];
  subagents?: SubagentInfo[];
  /** MCP tool definitions, already aliased for name collisions. */
  mcpTools?: ChannelToolDef[];
  /** Per-server grouping of the MCP tools, for the system prompt overview. */
  mcpServers?: McpServerInfo[];
  /**
   * Tools the application the person is using executes on its side (AG-UI's
   * frontend tools). A turn that calls one is the run's last: the calls are
   * announced, the run's own calls in that turn still run and report, and the
   * loop then ends with `done` so the application can answer its own — the
   * results come back as `tool` messages in the next run's history. Never
   * handed to a subagent: a child cannot end the run the person is waiting on.
   */
  clientTools?: ChannelToolDef[];
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
  delegations?: Array<{ scope: string; source: string; tool: string; id: string; args: string }>;
  agents: Record<string, RuntimeAgentSnapshot>;
  handoffs: Record<string, Array<{ source: string; tool: string; args: string }>>;
  identifiers: Record<string, { prefix?: string; used: string[] }>;
}

export interface RuntimeCheckpoint {
  graph: RuntimeGraphSnapshot;
  status: "pending" | "running";
  state: string;
  approvals: RuntimeApproval[];
  input: Omit<RunAgentInput, "signal" | "runtime" | "now"> & { now?: string };
  version: Version;
  pii: Array<[string, string]>;
  bindings: Record<string, string>;
  previousItemCount: number;
}

export interface RuntimeTurnPersistence {
  session: Session;
  filter?: PiiFilter;
  checkpoint?: RuntimeCheckpoint;
  decisions?: RuntimeApprovalDecision[];
  warnings: string[];
  images: ImageHandle[];
  checkBinding(key: string, fingerprint: string): void;
  commit(input: RunAgentInput, state: Pick<RunState<unknown, Agent<unknown, AgentOutputType>>, "getInterruptions" | "toString">, history: AgentInputItem[], graph: RuntimeGraphSnapshot): Promise<RuntimeApproval[]>;
}
