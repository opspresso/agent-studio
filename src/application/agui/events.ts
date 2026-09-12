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
 * **A turn is one assistant message.** The id is minted the moment a turn
 * first speaks or calls, and every `TOOL_CALL_START` of that turn names it as
 * `parentMessageId` — whether or not the turn said anything first. A client
 * that receives a call with no parent invents an assistant message per call,
 * so a turn that only called two tools became two empty bubbles and the next
 * run's history replayed them as two assistant turns. The turn ends when a
 * tool result arrives: the next words are the next turn's message.
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
import { VIEW_URL_TTL_SECONDS } from "@/shared/artifactUrlTtl";

export interface AguiRunIdentity {
  threadId: string;
  runId: string;
  /** Echoed on `RUN_STARTED` when the client sent one. */
  parentRunId?: string;
}

export interface AguiEventDeps {
  /** Addresses a file the run produced. Absent means files are reported as not kept. */
  sign?: SignObjectUrl;
  /** Mints message ids; injected so a test can read a deterministic stream. */
  newId?: () => string;
  /**
   * What the surface itself could not do for this run — said right after
   * `RUN_STARTED`, and collected onto `RUN_FINISHED.result` like the run's own.
   */
  warnings?: readonly string[];
}

/**
 * The run failing, as the protocol says it — for the translator and for a
 * failure it never saw. `code` is the error's class when it has one worth
 * naming (`RateLimitedError`, `UpstreamError`), so a client can branch without
 * parsing the sentence; a bare `Error` carries none.
 */
export function runErrorEvent(message: string, code?: string): AguiEvent {
  return { type: "RUN_ERROR", message, ...(code ? { code } : {}) };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && error.name && error.name !== "Error" ? error.name : undefined;
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
 *
 * `RUN_FINISHED` is emitted when the source is **exhausted**, not when the
 * terminal chunk passes: the artifact recorder says what it could not keep
 * only after the engine's stream has ended, so a finish on the `done` chunk
 * would drop the one warning about a picture that was drawn and lost.
 *
 * The source is closed in a `finally`, whichever yield the reader left at.
 * A client that hangs up returns *this* generator, and a `return()` reaches
 * the source only while the loop is delegating to it — not while
 * `RUN_STARTED` or a leading warning is the pending yield, which is the first
 * thing every run sends. Left unclosed there, the bracket never closes and
 * the run's concurrency slot is held until its deadline.
 */
export async function* toAguiEvents(
  source: AsyncGenerator<EngineChunk>,
  run: AguiRunIdentity,
  deps: AguiEventDeps = {},
): AsyncGenerator<AguiEvent> {
  try {
    // Outside the catch below on purpose: a refusal has to reach the route.
    const { value: head } = await source.next();
    const translator = new RunTranslator(run, deps);
    try {
      yield {
        type: "RUN_STARTED",
        threadId: run.threadId,
        runId: run.runId,
        ...(run.parentRunId ? { parentRunId: run.parentRunId } : {}),
      };
      for (const warning of deps.warnings ?? []) {
        yield* translator.collect({ warning });
      }
      if (head !== undefined) {
        yield* translator.observe(head);
        for await (const chunk of source) {
          yield* translator.observe(chunk);
        }
      }
      yield* translator.finish();
    } catch (error) {
      yield* translator.fail(error instanceof Error ? error.message : String(error), errorCode(error));
    }
  } finally {
    await source.return(undefined);
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
  /** How the engine said the run ended, held until the source is exhausted. */
  private termination: AguiRunResult["termination"] | undefined;
  /** The assistant message the current turn is, once it has said or called anything. */
  private turn: string | undefined;
  /** Whether the turn's text message is open right now. */
  private textOpen = false;
  private openReasoning: string | undefined;
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
    yield* this.collect(chunk);
    if (chunk.image) {
      yield {
        type: "ACTIVITY_SNAPSHOT",
        messageId: this.newId(),
        activityType: "agent-studio.image",
        content: {
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
        yield {
          type: "ACTIVITY_SNAPSHOT",
          messageId: this.newId(),
          activityType: "agent-studio.file",
          content: { ...outcome.file },
        };
      }
      yield* this.collect(outcome);
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
      if (!this.textOpen) {
        this.textOpen = true;
        yield { type: "TEXT_MESSAGE_START", messageId: this.turnId(), role: "assistant" };
      }
      yield { type: "TEXT_MESSAGE_CONTENT", messageId: this.turnId(), delta: chunk.delta.content };
    }
    if (chunk.delta?.toolCalls) {
      yield* this.closeReasoning();
      yield* this.closeText();
      for (const call of chunk.delta.toolCalls) {
        const toolCallId = call.id ?? this.newId();
        yield {
          type: "TOOL_CALL_START",
          toolCallId,
          toolCallName: call.function?.name ?? "",
          parentMessageId: this.turnId(),
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
      // The results end the turn: what the model says next is its next message.
      this.turn = undefined;
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
      // The answer is over, so what is open closes now; the ending itself
      // waits for the source, which may still have a loss to report.
      this.termination = termination;
      yield* this.closeAll();
    }
  }

  /** A loss, said once as it happens and kept for the ending. `collectedWarning` owns which count. */
  async *collect(loss: { warning?: string }): AsyncGenerator<AguiEvent> {
    const warning = collectedWarning(loss, this.warnings);
    if (warning) {
      this.warnings.push(warning);
      yield { type: "CUSTOM", name: "agent-studio.warning", value: { message: warning } };
    }
  }

  private async *observeAuthored(chunk: EngineChunk): AsyncGenerator<AguiEvent> {
    if (chunk.author === undefined) {
      return;
    }
    // The chain, not the innermost name: two children of one agent dispatched
    // at once would otherwise share a step, and the first to return would
    // close it under the other.
    const step = (chunk.authorPath ?? [chunk.author]).join("/");
    if (!this.openSteps.includes(step)) {
      yield* this.closeReasoning();
      yield* this.closeText();
      this.openSteps.push(step);
      yield { type: "STEP_STARTED", stepName: step };
    }
    if (chunk.authorDone) {
      yield* this.closeStep(step);
    }
  }

  /** The run's ending, once the source has nothing more to say. */
  async *finish(): AsyncGenerator<AguiEvent> {
    if (this.ended) {
      return;
    }
    if (this.termination === undefined) {
      yield* this.fail("Run ended without a terminal chunk.");
      return;
    }
    yield* this.closeAll();
    this.ended = true;
    const usage = this.usageReport();
    yield {
      type: "RUN_FINISHED",
      threadId: this.run.threadId,
      runId: this.run.runId,
      outcome: { type: "success" },
      result: { termination: this.termination, warnings: [...this.warnings] },
      ...(usage ? { usage: [usage] } : {}),
    };
  }

  async *fail(message: string, code?: string): AsyncGenerator<AguiEvent> {
    if (this.ended) {
      return;
    }
    yield* this.closeAll();
    this.ended = true;
    yield runErrorEvent(message, code);
  }

  private turnId(): string {
    if (this.turn === undefined) {
      this.turn = this.newId();
    }
    return this.turn;
  }

  private async *closeAll(): AsyncGenerator<AguiEvent> {
    yield* this.closeReasoning();
    yield* this.closeText();
    for (const step of [...this.openSteps].reverse()) {
      yield* this.closeStep(step);
    }
  }

  private async *closeText(): AsyncGenerator<AguiEvent> {
    if (this.textOpen && this.turn !== undefined) {
      yield { type: "TEXT_MESSAGE_END", messageId: this.turn };
      this.textOpen = false;
    }
  }

  private async *closeReasoning(): AsyncGenerator<AguiEvent> {
    if (this.openReasoning !== undefined) {
      yield { type: "REASONING_MESSAGE_END", messageId: this.openReasoning };
      yield { type: "REASONING_END", messageId: this.openReasoning };
      this.openReasoning = undefined;
    }
  }

  private async *closeStep(step: string): AsyncGenerator<AguiEvent> {
    const index = this.openSteps.indexOf(step);
    if (index >= 0) {
      this.openSteps.splice(index, 1);
      yield { type: "STEP_FINISHED", stepName: step };
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
