/**
 * The AG-UI wire shapes this platform speaks — the input a run is started
 * with and the events it answers in.
 *
 * Declared here rather than imported from `@ag-ui/core` on purpose. The
 * protocol *is* the contract, like A2A's, but its SDK pins zod 3 against this
 * app's zod 4 and is still on a 0.0.x line — so what would reach the use case
 * is a second schema library and a shape that may move under it. The event
 * names and fields are the published protocol's, spelled as it spells them;
 * the input is validated at the route with the app's own zod. Only what this
 * platform emits or reads is declared: the protocol has more events (state,
 * activity, raw), and a consumer written against the full schema reads these
 * as the subset they are.
 *
 * Pure TS, so a browser client may import it as well as a use case.
 */

/** A tool the client application declares — executed on its side, not here. */
export interface AguiTool {
  name: string;
  description: string;
  /** A JSON Schema object, as OpenAI-shaped function parameters are. */
  parameters?: Record<string, unknown>;
}

/** A fact the application wants the run to know, beside the conversation. */
export interface AguiContext {
  description: string;
  value: string;
}

export interface AguiFunctionCall {
  name: string;
  arguments: string;
}

export interface AguiToolCall {
  id: string;
  type: "function";
  function: AguiFunctionCall;
}

/** One part of a user turn. Only text and image parts reach the model here. */
export type AguiInputContent =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "data"; value: string; mimeType: string } | { type: "url"; value: string };
    };

export type AguiMessage =
  | { id: string; role: "developer" | "system"; content: string; name?: string }
  | { id: string; role: "user"; content: string | AguiInputContent[]; name?: string }
  | { id: string; role: "assistant"; content?: string; toolCalls?: AguiToolCall[]; name?: string }
  | { id: string; role: "tool"; content: string; toolCallId: string; error?: string }
  /** The client's record of what an earlier run showed it; not a turn of the conversation. */
  | { id: string; role: "reasoning"; content: string }
  | { id: string; role: "activity"; activityType: string; content: Record<string, unknown> };

/** What a client sends to start a run — the protocol's `RunAgentInput`. */
export interface AguiRunInput {
  threadId: string;
  runId: string;
  messages: AguiMessage[];
  tools: AguiTool[];
  context: AguiContext[];
  state?: unknown;
  forwardedProps?: unknown;
}

/** The protocol's token usage shape, one entry per model on `RUN_FINISHED`. */
export interface AguiTokenUsage {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
}

/**
 * The events this platform emits. `timestamp` is the protocol's optional base
 * field; it is left off — a frame's arrival order is its order.
 */
export type AguiEvent =
  | { type: "RUN_STARTED"; threadId: string; runId: string }
  | {
      type: "RUN_FINISHED";
      threadId: string;
      runId: string;
      outcome: { type: "success" };
      /** What this platform adds: how the run ended and what it lost. */
      result: AguiRunResult;
      usage?: AguiTokenUsage[];
    }
  | { type: "RUN_ERROR"; message: string; code?: string }
  | { type: "STEP_STARTED"; stepName: string }
  | { type: "STEP_FINISHED"; stepName: string }
  | { type: "TEXT_MESSAGE_START"; messageId: string; role: "assistant" }
  | { type: "TEXT_MESSAGE_CONTENT"; messageId: string; delta: string }
  | { type: "TEXT_MESSAGE_END"; messageId: string }
  | { type: "REASONING_START"; messageId: string }
  | { type: "REASONING_MESSAGE_START"; messageId: string; role: "reasoning" }
  | { type: "REASONING_MESSAGE_CONTENT"; messageId: string; delta: string }
  | { type: "REASONING_MESSAGE_END"; messageId: string }
  | { type: "REASONING_END"; messageId: string }
  | { type: "TOOL_CALL_START"; toolCallId: string; toolCallName: string; parentMessageId?: string }
  | { type: "TOOL_CALL_ARGS"; toolCallId: string; delta: string }
  | { type: "TOOL_CALL_END"; toolCallId: string }
  | { type: "TOOL_CALL_RESULT"; messageId: string; toolCallId: string; content: string; role: "tool" }
  | { type: "CUSTOM"; name: AguiCustomEventName; value: unknown };

/**
 * What the run ended with, carried on `RUN_FINISHED.result`.
 *
 * The protocol has no frame for a warning and no field for how a run ended,
 * and both are part of reading the answer: a run cut at its turn limit and a
 * run that finished look the same on the text axis. `termination` is the
 * engine's own vocabulary; `warnings` is what the run reported losing, in
 * order, deduplicated.
 */
export interface AguiRunResult {
  termination: "completed" | "turn-limit" | "output-limit";
  warnings: string[];
}

/**
 * The `CUSTOM` events this platform defines, namespaced so a client can tell
 * them from its own. Each carries what the protocol has no frame for.
 *
 * - `agent-studio.image` — a picture the run produced, inline as a `data:` URL
 *   (`{ mimeType, dataUrl, prompt?, model?, artifactId? }`).
 * - `agent-studio.file` — a file a tool produced, addressed for download
 *   (`{ name, mimeType, url, byteSize? }`); its bytes never travel.
 * - `agent-studio.warning` — a loss the run reported (`{ message }`), said as
 *   it happens; the same text is collected onto `RUN_FINISHED.result`.
 */
export type AguiCustomEventName = "agent-studio.image" | "agent-studio.file" | "agent-studio.warning";
