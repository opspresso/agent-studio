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

/**
 * One part of a user turn. Text and images reach the model as they are; a
 * document becomes text at this surface, the way every other surface's
 * attachment does. Audio and video have no path to a model here.
 */
export type AguiInputContent =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "data"; value: string; mimeType: string } | { type: "url"; value: string };
    }
  | {
      type: "document";
      source: { type: "data"; value: string; mimeType: string };
      /** The protocol leaves this open; a `name` or `filename` in it names the file. */
      metadata?: Record<string, unknown>;
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
  /** The run this one continues from, echoed on `RUN_STARTED`. */
  parentRunId?: string;
  messages: AguiMessage[];
  tools: AguiTool[];
  context: AguiContext[];
  state?: unknown;
  forwardedProps?: unknown;
}

/** The protocol's token usage shape on `RUN_FINISHED`; model identity is optional. */
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
  | { type: "RUN_STARTED"; threadId: string; runId: string; parentRunId?: string }
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
  | {
      type: "ACTIVITY_SNAPSHOT";
      messageId: string;
      activityType: AguiActivityType;
      content: Record<string, unknown>;
      replace?: boolean;
    }
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
 * What a run produced besides words, as `ACTIVITY_SNAPSHOT` messages.
 *
 * An activity is a message in the client's thread — rendered where the
 * answer is, by a renderer registered for its `activityType` — and it is
 * dropped from the messages a client sends back, so the bytes never reach
 * the model on the next run. That is exactly the pair of properties a picture
 * and a file need, and what a `CUSTOM` event lacks: a custom event reaches a
 * subscriber and nothing else, so an image project called over AG-UI showed
 * the client an empty run.
 *
 * - `agent-studio.image` — `{ mimeType, dataUrl, prompt?, model?, artifactId? }`,
 *   the picture inline as a `data:` URL.
 * - `agent-studio.file` — `{ name, mimeType, url, byteSize? }`, a signed
 *   download address; the bytes stayed at the bracket.
 */
export type AguiActivityType = "agent-studio.image" | "agent-studio.file";

/**
 * The one `CUSTOM` event this platform defines, namespaced so a client can
 * tell it from its own: `agent-studio.warning` — a loss the run reported
 * (`{ message }`), said as it happens; the same text is collected onto
 * `RUN_FINISHED.result`. A custom event reaches a subscriber and not the
 * thread, which is where a warning belongs.
 */
export type AguiCustomEventName = "agent-studio.warning";
