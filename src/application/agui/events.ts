/**
 * A run's chunk stream as AG-UI events.
 *
 * The engine answers in one axis-per-field chunks; AG-UI answers in a lifecycle
 * — a message is opened, streamed and closed, a tool call likewise, and a
 * client that receives a content delta for a message it never saw opened
 * rejects the stream. So this keeps what is open and closes it at the boundary
 * the next chunk implies: text closes when a tool call, a step or the run's
 * end arrives, reasoning closes when the answer begins, and both close before
 * `RUN_FINISHED`.
 *
 * Only a top-level chunk drives the lifecycle. A subagent's chunks are its own
 * run — its text returns to the parent as a tool result, its calls are its
 * business — and they surface here as a step (`STEP_STARTED` when the author
 * first speaks, `STEP_FINISHED` when it returns), never as messages. Two
 * things are read from every author: a picture and a file, because an image
 * subagent is how a project delegates drawing and the picture is the answer —
 * the same rule `collectRun` and the A2A executor follow — and a warning,
 * because a child's loss is this run's too (`collectedWarning` owns which
 * ones count).
 */

import type { AguiEvent, AguiRunResult, AguiTokenUsage } from "@/domain/agui/types";
import type { SignObjectUrl } from "@/domain/artifact/objectStore";
import {
  collectedWarning,
  imageDataUrl,
  isTopLevelChunk,
  runTermination,
  type EngineChunk,
} from "@/domain/llm/types";
import { fileRefOf, resolveProducedFile } from "@/application/artifact/producedFiles";
import { VIEW_URL_TTL_SECONDS } from "@/application/artifact/urlTtl";

export interface AguiRunIdentity {
  threadId: string;
  runId: string;
}

export interface AguiEventDeps {
  /** Addresses a file the run produced. Absent means files are reported as not kept. */
  sign?: SignObjectUrl;
  /** Mints message ids; injected so a test can read a deterministic stream. */
  newId?: () => string;
}

/**
 * Translate a run into AG-UI events.
 *
 * The first chunk is pulled **before** `RUN_STARTED` is emitted. A run is
 * refused on its first `next()` — the cost guard, the concurrency guard — and
 * the route turns that throw into a 429; an event stream that had already
 * begun would deliver the refusal as `RUN_ERROR` inside a 200. Anything thrown
 * after that point is the run failing mid-way and is reported as `RUN_ERROR`,
 * the way every other streaming surface turns it into an `{error}` frame.
 */
export async function* toAguiEvents(
  source: AsyncGenerator<EngineChunk>,
  run: AguiRunIdentity,
  deps: AguiEventDeps = {},
): AsyncGenerator<AguiEvent> {
  const { value: head } = await source.next();
  yield { type: "RUN_STARTED", threadId: run.threadId, runId: run.runId };
  const translator = new RunTranslator(run, deps);
  try {
    if (head !== undefined) {
      yield* translator.observe(head);
      for await (const chunk of source) {
        yield* translator.observe(chunk);
        // Nothing after the run's ending is for the reader, but the stream is
        // drained rather than returned: returning a generator mid-way runs its
        // cleanup as a cancellation, and the bracket would record a finished
        // run as one the caller abandoned.
      }
    }
    if (!translator.ended) {
      yield* translator.finish("completed");
    }
  } catch (error) {
    if (translator.ended) {
      return;
    }
    yield* translator.fail(error instanceof Error ? error.message : String(error));
  }
}

/** The usage a `RUN_FINISHED` reports, summed over every model call the run made. */
interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  calls: number;
}

class RunTranslator {
  /** `RUN_FINISHED` or `RUN_ERROR` has been emitted; nothing follows either. */
  ended = false;
  private openText: string | undefined;
  private openReasoning: string | undefined;
  /**
   * The assistant message the turn's tool calls belong to: the text message
   * the first call closed. Several calls of one response arrive as separate
   * chunks, so it is held until something other than a call arrives.
   */
  private callParent: string | undefined;
  private readonly openSteps: string[] = [];
  private readonly warnings: string[] = [];
  private readonly usage: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    calls: 0,
  };

  constructor(
    private readonly run: AguiRunIdentity,
    private readonly deps: AguiEventDeps,
  ) {}

  async *observe(chunk: EngineChunk): AsyncGenerator<AguiEvent> {
    if (this.ended) {
      return;
    }
    // Usage first: a terminal chunk may carry the run's last usage beside
    // `done`, and the total it contributes to is reported on the ending.
    if (chunk.usage) {
      this.usage.inputTokens += chunk.usage.inputTokens;
      this.usage.outputTokens += chunk.usage.outputTokens;
      this.usage.reasoningTokens += chunk.usage.reasoningTokens ?? 0;
      this.usage.cachedTokens += chunk.usage.cachedTokens ?? 0;
      this.usage.calls += 1;
    }
    const warning = collectedWarning(chunk, this.warnings);
    if (warning) {
      this.warnings.push(warning);
      yield { type: "CUSTOM", name: "agent-studio.warning", value: { message: warning } };
    }
    if (chunk.image) {
      yield {
        type: "CUSTOM",
        name: "agent-studio.image",
        value: {
          mimeType: chunk.image.mimeType,
          dataUrl: imageDataUrl(chunk.image),
          ...(chunk.image.prompt !== undefined ? { prompt: chunk.image.prompt } : {}),
          ...(chunk.image.model !== undefined ? { model: chunk.image.model } : {}),
          ...(chunk.image.artifactId !== undefined ? { artifactId: chunk.image.artifactId } : {}),
        },
      };
    }
    if (chunk.file) {
      // Resolved as it passes: the bytes were stripped at the bracket, so a
      // reader gets an address — and when there is none, the reason, rather
      // than a run that quietly finished without the document it produced.
      const outcome = await resolveProducedFile(
        fileRefOf(chunk.file),
        this.deps.sign,
        VIEW_URL_TTL_SECONDS,
      );
      if (outcome.file) {
        yield { type: "CUSTOM", name: "agent-studio.file", value: outcome.file };
      }
      const lost = outcome.warning && collectedWarning({ warning: outcome.warning }, this.warnings);
      if (lost) {
        this.warnings.push(lost);
        yield { type: "CUSTOM", name: "agent-studio.warning", value: { message: lost } };
      }
    }
    if (!isTopLevelChunk(chunk)) {
      yield* this.observeAuthored(chunk);
      return;
    }
    if (chunk.error !== undefined) {
      yield* this.fail(chunk.error);
      return;
    }
    if (chunk.delta?.reasoningContent) {
      yield* this.closeText();
      this.callParent = undefined;
      if (this.openReasoning === undefined) {
        this.openReasoning = this.newId();
        yield { type: "REASONING_START", messageId: this.openReasoning };
        yield { type: "REASONING_MESSAGE_START", messageId: this.openReasoning, role: "reasoning" };
      }
      yield {
        type: "REASONING_MESSAGE_CONTENT",
        messageId: this.openReasoning,
        delta: chunk.delta.reasoningContent,
      };
    }
    if (chunk.delta?.content) {
      yield* this.closeReasoning();
      this.callParent = undefined;
      if (this.openText === undefined) {
        this.openText = this.newId();
        yield { type: "TEXT_MESSAGE_START", messageId: this.openText, role: "assistant" };
      }
      yield { type: "TEXT_MESSAGE_CONTENT", messageId: this.openText, delta: chunk.delta.content };
    }
    if (chunk.delta?.toolCalls) {
      yield* this.closeReasoning();
      // The text this turn spoke before calling is the message the calls
      // hang off; a turn that only called gets a message of its own on the
      // client, which is what an absent parent means there.
      if (this.openText !== undefined) {
        this.callParent = this.openText;
        yield* this.closeText();
      }
      for (const call of chunk.delta.toolCalls) {
        const toolCallId = call.id ?? this.newId();
        yield {
          type: "TOOL_CALL_START",
          toolCallId,
          toolCallName: call.function?.name ?? "",
          ...(this.callParent !== undefined ? { parentMessageId: this.callParent } : {}),
        };
        if (call.function?.arguments) {
          yield { type: "TOOL_CALL_ARGS", toolCallId, delta: call.function.arguments };
        }
        yield { type: "TOOL_CALL_END", toolCallId };
      }
    }
    if (chunk.toolResult) {
      yield* this.closeReasoning();
      yield* this.closeText();
      this.callParent = undefined;
      yield {
        type: "TOOL_CALL_RESULT",
        messageId: this.newId(),
        toolCallId: chunk.toolResult.toolCallId,
        content: chunk.toolResult.content,
        role: "tool",
      };
    }
    const termination = runTermination(chunk);
    if (termination !== undefined && termination !== "error" && termination !== "cancelled") {
      yield* this.finish(termination);
    }
  }

  private async *observeAuthored(chunk: EngineChunk): AsyncGenerator<AguiEvent> {
    const author = chunk.author;
    if (author === undefined) {
      return;
    }
    if (!this.openSteps.includes(author)) {
      yield* this.closeReasoning();
      yield* this.closeText();
      this.openSteps.push(author);
      yield { type: "STEP_STARTED", stepName: author };
    }
    if (chunk.authorDone) {
      yield* this.closeStep(author);
    }
  }

  async *finish(termination: AguiRunResult["termination"]): AsyncGenerator<AguiEvent> {
    yield* this.closeAll();
    this.ended = true;
    const usage = this.usageReport();
    yield {
      type: "RUN_FINISHED",
      threadId: this.run.threadId,
      runId: this.run.runId,
      outcome: { type: "success" },
      result: { termination, warnings: [...this.warnings] },
      ...(usage ? { usage: [usage] } : {}),
    };
  }

  async *fail(message: string): AsyncGenerator<AguiEvent> {
    yield* this.closeAll();
    this.ended = true;
    yield { type: "RUN_ERROR", message };
  }

  private async *closeAll(): AsyncGenerator<AguiEvent> {
    yield* this.closeReasoning();
    yield* this.closeText();
    for (const author of [...this.openSteps].reverse()) {
      yield* this.closeStep(author);
    }
  }

  private async *closeText(): AsyncGenerator<AguiEvent> {
    if (this.openText !== undefined) {
      yield { type: "TEXT_MESSAGE_END", messageId: this.openText };
      this.openText = undefined;
    }
  }

  private async *closeReasoning(): AsyncGenerator<AguiEvent> {
    if (this.openReasoning !== undefined) {
      yield { type: "REASONING_MESSAGE_END", messageId: this.openReasoning };
      yield { type: "REASONING_END", messageId: this.openReasoning };
      this.openReasoning = undefined;
    }
  }

  private async *closeStep(author: string): AsyncGenerator<AguiEvent> {
    const index = this.openSteps.indexOf(author);
    if (index >= 0) {
      this.openSteps.splice(index, 1);
      yield { type: "STEP_FINISHED", stepName: author };
    }
  }

  private usageReport(): AguiTokenUsage | undefined {
    if (this.usage.calls === 0) {
      return undefined;
    }
    return {
      inputTokens: this.usage.inputTokens,
      outputTokens: this.usage.outputTokens,
      totalTokens: this.usage.inputTokens + this.usage.outputTokens,
      ...(this.usage.reasoningTokens > 0 ? { reasoningTokens: this.usage.reasoningTokens } : {}),
      ...(this.usage.cachedTokens > 0 ? { cachedInputTokens: this.usage.cachedTokens } : {}),
    };
  }

  private newId(): string {
    return this.deps.newId ? this.deps.newId() : crypto.randomUUID();
  }
}
