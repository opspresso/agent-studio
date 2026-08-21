import { chunkTermination, isTopLevelChunk } from "@/domain/llm/types";
import type { EngineChunk, RunResult, RunTerminationReason } from "@/domain/llm/types";
import type { RunImage } from "@/application/execution/runProject";
import { fileRefOf } from "@/application/artifact/producedFiles";
import type { ProducedFile, ProducedFileRef } from "@/application/artifact/producedFiles";

function newChatId(): string {
  return `chatcmpl-${crypto.randomUUID().replace(/-/g, "")}`;
}

/**
 * The one OpenAI spelling of a run's ending — the collected and streaming
 * responses used to each keep their own mapping, and they had already
 * disagreed (`turn-limit` was `length` on the stream and `stop` collected).
 * Exhaustive on purpose: a reason added to `RunTerminationReason` fails to
 * compile here instead of silently folding into `stop`.
 */
function wireFinishReason(termination: RunTerminationReason | undefined): "stop" | "length" {
  switch (termination) {
    case "turn-limit":
    case "output-limit":
      return "length";
    case "completed":
      return "stop";
    case "error":
    case "cancelled":
      // Neither reaches a finish_reason frame: an error throws before mapping
      // and a cancellation never yields a terminal chunk. Refusing loudly
      // beats minting a `stop` for a run that did not stop.
      throw new Error(`termination "${termination}" has no finish_reason frame`);
    case undefined:
      // A run that announced nothing. The engine always announces, so absence
      // is a producer defect — and one that has shipped (an image dispatch
      // once ended its stream bare). The stream path already refuses; minting
      // a `stop` here kept the same defect invisible on the collected surface.
      throw new Error("run ended without announcing a termination reason");
  }
}

/** Wrap a single-shot result as an OpenAI ChatCompletion object. */
export function toChatCompletion(
  result: RunResult & {
    images?: RunImage[];
    /** Already addressable: the route signs a reference before it gets here. */
    files?: ProducedFile[];
    warnings?: string[];
    termination?: RunTerminationReason;
  },
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
        finish_reason: wireFinishReason(result.termination),
      },
    ],
    usage: {
      prompt_tokens: result.usage.inputTokens,
      completion_tokens: result.usage.outputTokens,
      total_tokens: result.usage.inputTokens + result.usage.outputTokens,
      // Not an extension like the three below it: `completion_tokens_details`
      // is the OpenAI schema's own field, spelled the way the channel already
      // reads it on the way in, and it is a *subset* of `completion_tokens`
      // rather than a number to add. Without it the same run bills differently
      // depending on which of this project's two endpoints asked — which is
      // the inconsistency `collectRun` carries it for.
      ...(result.usage.reasoningTokens
        ? { completion_tokens_details: { reasoning_tokens: result.usage.reasoningTokens } }
        : {}),
    },
    ...(result.images && result.images.length > 0 ? { images: result.images } : {}),
    // Same extension treatment as `images`, and for the same reason: the OpenAI
    // schema has no field for what a run lost, and dropping it is what left a
    // degraded run looking exactly like a clean one on this surface.
    ...(result.warnings && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    // And again for what it produced but cannot inline. A document rides as an
    // address rather than bytes, which is the one way this extension differs
    // from `images` beside it.
    ...(result.files && result.files.length > 0 ? { files: result.files } : {}),
  };
}

/**
 * Reshape engine chunks into OpenAI `chat.completion.chunk` objects for SSE.
 * Only top-level content reaches the OpenAI client; nested subagent chunks are
 * internal to the agent loop and hidden here.
 *
 * Every stream ends with exactly one finish_reason chunk, read from the
 * termination the engine announces (`chunkTermination`) and spelled by
 * {@link wireFinishReason}: a normal completion is `stop`; the turn guard and
 * a provider output cut are `length` — the OpenAI signal for "stopped at a
 * limit". The reason used to be inferred from the *absence* of `done`, which
 * misreported a cancellation and a mid-stream error as `length`; a stream that
 * ends without announcing anything is now a defect and fails the request
 * rather than being dressed up as a length stop.
 */
export async function* toChatCompletionChunks(
  source: AsyncGenerator<EngineChunk>,
  model: string,
  /**
   * Turns a file reference into an address, or says why it has none. Supplied by
   * the route, which is the layer that knows this deployment's signer and how
   * long a signature should live. Absent means files pass unmentioned, which is
   * what every caller of this function did before there were any.
   */
  resolveFile?: (
    file: ProducedFileRef,
  ) => Promise<{ file?: ProducedFile; warning?: string }>,
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
    if (chunk.file && resolveFile) {
      // Before the top-level filter for the reason `images` is: a transferred-to
      // agent rendering the document is how the work gets done, and the file is
      // this run's output either way. Resolved as it passes rather than held to
      // the end — a stream has no later frame to put it in, which is exactly the
      // hole that made this surface silent about files at all.
      const outcome = await resolveFile(fileRefOf(chunk.file));
      const delta = outcome.file
        ? { files: [outcome.file] }
        : outcome.warning
          ? { warnings: [outcome.warning] }
          : undefined;
      if (delta) {
        const withRole = sentRole ? delta : { role: "assistant", ...delta };
        sentRole = true;
        yield { ...base, choices: [{ index: 0, delta: withRole, finish_reason: null }] };
      }
    }
    if (chunk.warning) {
      // Before the top-level filter, like `images` above: a subagent's warning
      // names its own agent and its loss is the caller's too. No OpenAI
      // counterpart either, so it rides as a `warnings` delta extension — which
      // is what keeps this stream saying the same thing its collected
      // counterpart does. A client that does not know the field ignores it.
      const warnings = [chunk.warning];
      const delta = sentRole ? { warnings } : { role: "assistant", warnings };
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
    if (termination !== undefined) {
      finished = true;
      yield {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: wireFinishReason(termination) }],
      };
    }
  }
  if (!finished) {
    throw new Error("run ended without announcing a termination reason");
  }
}
