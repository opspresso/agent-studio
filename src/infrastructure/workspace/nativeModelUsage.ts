import type { NativeModelProtocol, NativeModelUsage } from "@/domain/workspace/modelGateway";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const counter = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Observe provider request counters, never CLI session-cumulative or locally estimated totals. */
export function createNativeUsageObserver(protocol: NativeModelProtocol) {
  let snapshot: Record<string, unknown> = {};
  let completed = false;
  let seen = false;
  return {
    observe(value: unknown, json = false) {
      const event = object(value);
      const response = protocol === "responses" ? object(event.response ?? event) : event;
      const next = protocol === "messages" && event.type === "message_start" ? object(object(event.message).usage) : object(response.usage);
      if (Object.keys(next).length) { snapshot = { ...snapshot, ...next }; seen = true; }
      if (json || event.type === "response.completed" || event.type === "response.incomplete" ||
        event.type === "message_stop" || value === "[DONE]") completed = true;
    },
    result(): { usage?: NativeModelUsage; complete: boolean } {
      if (!seen) return { complete: false };
      const input = counter(snapshot[protocol === "chat/completions" ? "prompt_tokens" : "input_tokens"]);
      const output = counter(snapshot[protocol === "chat/completions" ? "completion_tokens" : "output_tokens"]);
      if (input === undefined || output === undefined) return { complete: false };
      const cached = protocol === "messages" ? counter(snapshot.cache_read_input_tokens) ?? 0
        : counter(object(snapshot[protocol === "chat/completions" ? "prompt_tokens_details" : "input_tokens_details"]).cached_tokens) ?? 0;
      const writes = protocol === "messages" ? counter(snapshot.cache_creation_input_tokens) ?? 0 : 0;
      const totalInput = input + (protocol === "messages" ? cached + writes : 0);
      if (!Number.isSafeInteger(totalInput) || cached > totalInput) return { complete: false };
      const billed = snapshot.cost ?? snapshot.cost_usd;
      return { complete: completed, usage: { inputTokens: totalInput, outputTokens: output,
        cachedTokens: cached, reasoningTokens: counter(object(snapshot[protocol === "chat/completions" ? "completion_tokens_details" : "output_tokens_details"]).reasoning_tokens) ?? 0,
        ...(typeof billed === "number" && Number.isFinite(billed) && billed >= 0 ? { costUsd: billed } : {}) } };
    },
  };
}
