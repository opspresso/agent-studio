import { isTopLevelChunk } from "@/domain/llm/types";
import type { EngineChunk, RunResult, UsageInfo } from "@/domain/llm/types";

function newChatId(): string {
  return `chatcmpl-${crypto.randomUUID().replace(/-/g, "")}`;
}

/** Wrap a single-shot result as an OpenAI ChatCompletion object. */
export function toChatCompletion(result: RunResult): Record<string, unknown> {
  return {
    id: newChatId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: result.model,
    choices: [
      { index: 0, message: { role: "assistant", content: result.content }, finish_reason: "stop" },
    ],
    usage: {
      prompt_tokens: result.usage.inputTokens,
      completion_tokens: result.usage.outputTokens,
      total_tokens: result.usage.inputTokens + result.usage.outputTokens,
    },
  };
}

/**
 * Reshape engine chunks into OpenAI `chat.completion.chunk` objects for SSE.
 * Only top-level content reaches the OpenAI client; nested subagent chunks are
 * internal to the agent loop and hidden here.
 *
 * Every stream ends with exactly one finish_reason chunk. `done` means the
 * model stopped on its own → `stop`. An agent loop that exhausts its turn
 * budget ends without `done` (see the turn guard in engine.runAgent) → `length`,
 * the OpenAI signal for "stopped at a limit". Without this an OpenAI client
 * would see the stream simply cut off.
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
      throw new Error(chunk.error);
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
    if (chunk.done) {
      finished = true;
      yield { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
    }
  }
  if (!finished) {
    yield { ...base, choices: [{ index: 0, delta: {}, finish_reason: "length" }] };
  }
}

/** Drain an agent stream into a single assistant answer (non-stream chat/completions). */
export async function collectRun(
  source: AsyncGenerator<EngineChunk>,
  model: string,
): Promise<RunResult> {
  let content = "";
  const usage: UsageInfo = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  for await (const chunk of source) {
    if (chunk.error) {
      throw new Error(chunk.error);
    }
    if (isTopLevelChunk(chunk) && chunk.delta?.content) {
      content += chunk.delta.content;
    }
    // Usage counts every chunk, subagent turns included, so the reported
    // usage matches what the run actually billed.
    if (chunk.usage) {
      usage.inputTokens += chunk.usage.inputTokens;
      usage.outputTokens += chunk.usage.outputTokens;
      usage.costUsd += chunk.usage.costUsd;
    }
  }
  return { content, model, usage };
}
