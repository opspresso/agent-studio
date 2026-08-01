import { chunkTermination, isTopLevelChunk } from "@/domain/llm/types";
import type { EngineChunk, RunResult, RunTerminationReason } from "@/domain/llm/types";
import type { RunImage } from "@/application/execution/runProject";

function newChatId(): string {
  return `chatcmpl-${crypto.randomUUID().replace(/-/g, "")}`;
}

/**
 * Wrap a single-shot result as an OpenAI ChatCompletion object. A run that
 * ended at its turn limit reports `length` — OpenAI's value for "stopped at a
 * limit" — and every other collected run finished on its own.
 */
export function toChatCompletion(
  result: RunResult & { images?: RunImage[]; termination?: RunTerminationReason },
): Record<string, unknown> {
  return {
    id: newChatId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: result.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: result.content },
        finish_reason: result.termination === "turn-limit" ? "length" : "stop",
      },
    ],
    usage: {
      prompt_tokens: result.usage.inputTokens,
      completion_tokens: result.usage.outputTokens,
      total_tokens: result.usage.inputTokens + result.usage.outputTokens,
    },
    ...(result.images && result.images.length > 0 ? { images: result.images } : {}),
  };
}

/**
 * Reshape engine chunks into OpenAI `chat.completion.chunk` objects for SSE.
 * Only top-level content reaches the OpenAI client; nested subagent chunks are
 * internal to the agent loop and hidden here.
 *
 * Every stream ends with exactly one finish_reason chunk, read from the
 * termination the engine announces (`chunkTermination`): a normal completion is
 * `stop`, a run ended by its turn guard is `length` — the OpenAI signal for
 * "stopped at a limit". The reason used to be inferred from the *absence* of
 * `done`, which misreported a cancellation and a mid-stream error as `length`;
 * a stream that ends without announcing anything is now a defect and fails the
 * request rather than being dressed up as a length stop.
 */
export async function* toChatCompletionChunks(
  source: AsyncGenerator<EngineChunk>,
  model: string,
): AsyncGenerator<Record<string, unknown>> {
  const base = { id: newChatId(), object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
  let sentRole = false;
  let finished = false;
  for await (const chunk of source) {
    if (chunk.error) {
      // An authored error is a subagent failure the engine reports to the parent
      // as a tool error; the parent goes on to answer, so it must not end the
      // stream. Only a top-level failure fails the request.
      if (isTopLevelChunk(chunk)) {
        throw new Error(chunk.error);
      }
      continue;
    }
    if (chunk.image) {
      // Images come from subagent turns too (an image subagent is how an agent
      // project delegates drawing), so this is checked before the top-level
      // filter. No OpenAI counterpart: an `images` delta extension, so a client
      // that knows about it receives the picture and one that does not ignores it.
      const images = [chunk.image];
      const delta = sentRole ? { images } : { role: "assistant", images };
      sentRole = true;
      yield { ...base, choices: [{ index: 0, delta, finish_reason: null }] };
    }
    if (!isTopLevelChunk(chunk)) {
      continue;
    }
    const content = chunk.delta?.content;
    if (content) {
      const delta = sentRole ? { content } : { role: "assistant", content };
      sentRole = true;
      yield { ...base, choices: [{ index: 0, delta, finish_reason: null }] };
    }
    const termination = chunkTermination(chunk);
    if (termination === "completed") {
      finished = true;
      yield { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
    } else if (termination === "turn-limit") {
      finished = true;
      yield { ...base, choices: [{ index: 0, delta: {}, finish_reason: "length" }] };
    }
  }
  if (!finished) {
    throw new Error("run ended without announcing a termination reason");
  }
}
