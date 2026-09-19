import { randomUUID } from "node:crypto";
import { chunkAuthorPath, runTermination, toolCallKey, isTopLevelChunk } from "@/domain/llm/types";
import type { EngineChunk, RunResult } from "@/domain/llm/types";
import type { TraceRepository } from "@/domain/trace/repository";
import type { Trace, TraceSpan } from "@/domain/trace/types";
import type { RunActor } from "@/domain/execution/actor";
import { linkTrace } from "@/shared/runContext";

const MAX_PREVIEW_CHARS = 1_000;
const MAX_SPANS = 100;
/** A run reports one warning per unusable binding; the item stays bounded. */
const MAX_WARNINGS = 20;
/**
 * How many discovered capability names a `prepare` span may name. Bounded for
 * the same reason every accumulator here is — a trace is one row, read whole —
 * and the count beside the list is the total found, so a shorter list under a
 * larger count says how many are not shown.
 */
export const MAX_TRACED_DISCOVERED = 20;

export interface TraceContext {
  projectName: string;
  projectType: string;
  model: string;
  messageCount: number;
  /** Transfer chain that reached this run, outermost first. */
  ancestry?: string[];
  /** Who caused the run; a subagent inherits its parent's. */
  actor?: RunActor;
  /** The conversation key (`conversationKey`) the run belongs to, when the surface has one. */
  conversation?: string;
}

/** What one transfer contributed, accumulated while its chunks stream by. */
interface SubagentEntry {
  /** The agent THIS run transferred to — one span per transfer, not per depth. */
  child: string;
  /** Deepest chain observed under that transfer, e.g. "sample-agent → simple-image". */
  deepestChain: string[];
  traceId?: string;
  startedAt: Date;
  lastSeenAt: Date;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  error?: string;
}

/**
 * How many entries a span's `output` may name, and how many fields it may hold.
 * Small on purpose: a span's output is metadata about a stage, not a payload.
 */
const MAX_OUTPUT_FIELDS = 20;

/**
 * A stage's `output`, cut to what a trace row can carry: numbers and booleans
 * as they are, strings previewed, arrays kept to {@link MAX_TRACED_DISCOVERED}
 * previewed entries, anything else dropped rather than serialised blind.
 */
function boundedOutput(output: Record<string, unknown>): Record<string, unknown> {
  const bounded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(output).slice(0, MAX_OUTPUT_FIELDS)) {
    if (typeof value === "number" || typeof value === "boolean") {
      bounded[key] = value;
    } else if (typeof value === "string") {
      bounded[key] = preview(value);
    } else if (Array.isArray(value)) {
      bounded[key] = value
        .slice(0, MAX_TRACED_DISCOVERED)
        .map((entry) => (typeof entry === "string" ? preview(entry) : String(entry)));
    }
  }
  return bounded;
}

function preview(value: string): string {
  return value.length <= MAX_PREVIEW_CHARS
    ? value
    : `${value.slice(0, MAX_PREVIEW_CHARS)}…`;
}

export class TraceRecorder {
  readonly traceId = randomUUID();
  private readonly startedAt = new Date();
  private modelStartedAt = this.startedAt;
  private readonly spans: TraceSpan[] = [];
  private spansDropped = 0;
  private readonly pendingTools = new Map<string, { name: string; startedAt: Date; inputChars: number }>();
  /** Keyed by the always-present delegation id; trace sampling is only a link. */
  private readonly subagents = new Map<string, SubagentEntry>();
  private readonly warnings: string[] = [];
  private error: string | undefined;
  /**
   * Whether this run stopped at a limit. Read from the top level only:
   * an authored termination is a child's, absorbed into the parent's tool
   * result, and must not mark the parent's trace.
   */
  private limit: "turn-limit" | "output-limit" | undefined;
  private sdkRuntime = false;
  private awaitingApproval = false;

  useSdkRuntime(): void { this.sdkRuntime = true; }

  observeSdkSpan(span: TraceSpan): void { this.addSpan(span); }

  constructor(
    private readonly repository: TraceRepository,
    private readonly context: TraceContext,
  ) {
    // Join the two ids for anything reading logs. Only the first sticks, which
    // is the top-level run's — a subagent's recorder is constructed later, and
    // its trace is reachable from the parent's anyway.
    linkTrace(this.traceId);
  }

  /**
   * A stage that ran before the first token, with what it produced.
   *
   * It also moves where the next model span starts: preparation is the model's
   * *wait*, not its work, and the recorder is constructed before it (on purpose
   * — a resolve that throws must still leave a trace). Without this the first
   * model span opened at run start and every second spent opening MCP sessions
   * or asking memory was reported at the model's name.
   */
  observePrepare(
    name: string,
    startedAt: Date,
    detail?: { status?: "ok" | "error"; output?: Record<string, unknown> },
  ): void {
    // Bounded here rather than by whoever calls: every other cap on this item
    // (spans, warnings, previews) is the recorder's, and one caller handing an
    // unbounded payload overflows the 400KB row — at which point `put` throws
    // and the *whole* trace is lost, which is what the dropped-span accounting
    // exists to make impossible.
    const now = new Date();
    this.addSpan({
      spanId: randomUUID(),
      kind: "prepare",
      name,
      startedAt: startedAt.toISOString(),
      endedAt: now.toISOString(),
      durationMs: Math.max(0, now.getTime() - startedAt.getTime()),
      status: detail?.status ?? "ok",
      ...(detail?.output ? { output: boundedOutput(detail.output) } : {}),
    });
    // Outside `addSpan`, which drops past the cap: a dropped span must still
    // not leave its duration inside the next model call.
    this.modelStartedAt = now;
  }

  observe(chunk: EngineChunk): void {
    const now = new Date();
    if (chunk.warning && this.warnings.length < MAX_WARNINGS) {
      this.warnings.push(preview(chunk.warning));
    }
    const termination = runTermination(chunk);
    if (termination === "turn-limit" || termination === "output-limit") {
      this.limit = termination;
    }
    if (chunk.approval && isTopLevelChunk(chunk)) this.awaitingApproval = true;
    if (this.sdkRuntime) {
      if (chunk.error && isTopLevelChunk(chunk)) this.error = chunk.error;
      return;
    }
    for (const call of chunk.delta?.toolCalls ?? []) {
      const id = call.id;
      if (id) {
        this.pendingTools.set(toolCallKey(chunk, id), {
          name: call.function?.name ?? "tool",
          startedAt: now,
          inputChars: call.function?.arguments?.length ?? 0,
        });
      }
    }
    if (chunk.toolResult) {
      const key = toolCallKey(chunk, chunk.toolResult.toolCallId);
      const pending = this.pendingTools.get(key);
      const started = pending?.startedAt ?? now;
      this.addSpan({
        spanId: randomUUID(),
        kind: "tool",
        name: pending?.name ?? chunk.toolResult.name,
        ...(chunk.author ? { author: chunk.author } : {}),
        startedAt: started.toISOString(),
        endedAt: now.toISOString(),
        durationMs: Math.max(0, now.getTime() - started.getTime()),
        status: chunk.toolResult.content.startsWith("Error:") ? "error" : "ok",
        input: pending ? { argumentChars: pending.inputChars } : undefined,
        output: { contentChars: chunk.toolResult.content.length },
      });
      this.pendingTools.delete(key);
      // Where the next model call starts. Without this the tool's own duration
      // was counted twice — on its span and again inside the model span that
      // follows it — which is the misreading `prepare` was added to remove, in
      // the place an agent run does most of its waiting. Every result moves it,
      // so a response's concurrent calls leave it at the last one to land.
      this.modelStartedAt = now;
    }

    const subagent = chunk.author ? this.trackSubagent(chunk, now) : undefined;

    if (chunk.usage) {
      if (subagent) {
        // The tokens belong to the child's model, which this run does not know —
        // recording them as a model span here would attribute them to the parent's
        // model. They roll up onto the subagent span instead; the child's own
        // trace holds the per-model detail.
        subagent.inputTokens += chunk.usage.inputTokens;
        subagent.outputTokens += chunk.usage.outputTokens;
        subagent.costUsd += chunk.usage.costUsd;
      } else {
        const modelStartedAt = this.modelStartedAt;
        this.addSpan({
          spanId: randomUUID(),
          kind: "model",
          name: chunk.usage.model ?? this.context.model,
          startedAt: modelStartedAt.toISOString(),
          endedAt: now.toISOString(),
          durationMs: Math.max(0, now.getTime() - modelStartedAt.getTime()),
          status: "ok",
          input: {
            messages: this.context.messageCount,
            inputTokens: chunk.usage.inputTokens,
            // Per turn, which is where a cache regression is legible: the first
            // turn of a run is cold by definition, and a prompt that stopped
            // being cacheable shows up as every later turn being cold too.
            // Omitted when the provider reported none, so a span from a channel
            // that does not report the field is what it always was.
            ...(chunk.usage.cachedTokens ? { cachedTokens: chunk.usage.cachedTokens } : {}),
          },
          output: {
            outputTokens: chunk.usage.outputTokens,
            // The share of the output spent before the first visible word.
            // Named beside the total for the reason `cachedTokens` is named
            // beside its own: it is a subset, it moves the bill on its own, and
            // it is invisible in every other number a span carries — a turn
            // that thought for 4,000 tokens and answered in ten looks, without
            // it, like a turn that wrote 4,010 words. Omitted where nobody
            // reported one, so "0 thinking" never stands in for "nobody said".
            ...(chunk.usage.reasoningTokens ? { reasoningTokens: chunk.usage.reasoningTokens } : {}),
            costUsd: chunk.usage.costUsd,
          },
        });
        this.modelStartedAt = now;
      }
    }
    if (chunk.error) {
      if (subagent) {
        // A failed transfer is reported to the parent as a tool error and the
        // parent may still answer, so it fails the span, not the whole run.
        subagent.error = chunk.error;
      } else {
        this.error = chunk.error;
      }
    }
  }

  observeResult(result: RunResult): void {
    if (result.termination === "output-limit" || result.termination === "turn-limit") {
      this.limit = result.termination;
    }
    if (this.sdkRuntime) {
      const model = this.spans.findLast((span) => span.kind === "model" && span.status === "ok");
      if (model) {
        model.name = result.model;
        model.input = { inputTokens: result.usage.inputTokens, ...(result.usage.cachedTokens ? { cachedTokens: result.usage.cachedTokens } : {}) };
        model.output = { ...model.output, outputTokens: result.usage.outputTokens, costUsd: result.usage.costUsd };
      }
      return;
    }
    const now = new Date();
    // `modelStartedAt`, not `startedAt`: the two are the same until a stage
    // moves the boundary, and reading the run's start here would count any
    // preparation twice the moment a single-shot or image path records one.
    const modelStartedAt = this.modelStartedAt;
    this.addSpan({
      spanId: randomUUID(),
      kind: "model",
      name: result.model,
      startedAt: modelStartedAt.toISOString(),
      endedAt: now.toISOString(),
      durationMs: now.getTime() - modelStartedAt.getTime(),
      status: "ok",
      input: {
        messages: this.context.messageCount,
        inputTokens: result.usage.inputTokens,
      },
      output: {
        outputTokens: result.usage.outputTokens,
        costUsd: result.usage.costUsd,
        contentChars: result.content.length,
      },
    });
  }

  async finish(thrown?: unknown, cancelled = false): Promise<void> {
    const endedAt = new Date();
    if (cancelled) {
      this.error = undefined;
    } else if (thrown !== undefined) {
      this.error = thrown instanceof Error ? thrown.message : String(thrown);
    }
    for (const subagent of this.subagents.values()) {
      const deeper = subagent.deepestChain.length > 1;
      this.addSpan({
        spanId: randomUUID(),
        kind: "subagent",
        name: subagent.child,
        author: subagent.child,
        startedAt: subagent.startedAt.toISOString(),
        // The last chunk seen from this agent — the parent's own end time would
        // stretch the span over everything that ran after the transfer returned.
        endedAt: subagent.lastSeenAt.toISOString(),
        durationMs: Math.max(0, subagent.lastSeenAt.getTime() - subagent.startedAt.getTime()),
        status: subagent.error ? "error" : "ok",
        output: {
          ...(subagent.traceId ? { subagentTraceId: subagent.traceId } : {}),
          // How deep the transfer actually went — the run that answered is the
          // last name, which is what "who ran this" asks for.
          ...(deeper ? { chain: subagent.deepestChain.join(" → ") } : {}),
          inputTokens: subagent.inputTokens,
          outputTokens: subagent.outputTokens,
          costUsd: subagent.costUsd,
          ...(subagent.error ? { error: preview(subagent.error) } : {}),
        },
      });
    }
    const trace: Trace = {
      traceId: this.traceId,
      projectName: this.context.projectName,
      projectType: this.context.projectType,
      ...(this.context.ancestry && this.context.ancestry.length > 1
        ? { ancestry: this.context.ancestry }
        : {}),
      ...(this.context.actor ? { actor: this.context.actor } : {}),
      ...(this.context.conversation ? { conversation: this.context.conversation } : {}),
      status: cancelled
        ? "cancelled"
        : this.error
          ? "failed"
          : this.awaitingApproval ? "awaiting-approval" : this.limit ?? "completed",
      spans: this.spans,
      ...(this.spansDropped > 0 ? { spansDropped: this.spansDropped } : {}),
      ...(this.warnings.length > 0 ? { warnings: this.warnings } : {}),
      startedAt: this.startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs: Math.max(0, endedAt.getTime() - this.startedAt.getTime()),
      ...(this.error ? { error: preview(this.error) } : {}),
      createdAt: this.startedAt.toISOString(),
    };
    await this.repository.put(trace);
  }

  /** Open or update the entry for the transfer this chunk came from. */
  private trackSubagent(chunk: EngineChunk, now: Date): SubagentEntry {
    const author = chunk.author as string;
    const path = chunkAuthorPath(chunk)!;
    // The hop this run made; anything below it belongs to the same transfer.
    const child = path[0] ?? author;
    const key = chunk.transferId ?? `${child}#${chunk.traceId ?? "-"}`;
    // While a child streams, this run is not inside a model call — so its next
    // model span starts here, not before the transfer. Without this the child's
    // whole duration lands on the parent's next model span.
    this.modelStartedAt = now;
    const existing = this.subagents.get(key);
    if (existing) {
      existing.lastSeenAt = now;
      if (path.length > existing.deepestChain.length) {
        existing.deepestChain = path;
      }
      return existing;
    }
    const entry: SubagentEntry = {
      child,
      deepestChain: path,
      ...(chunk.traceId ? { traceId: chunk.traceId } : {}),
      startedAt: now,
      lastSeenAt: now,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
    this.subagents.set(key, entry);
    return entry;
  }

  private addSpan(span: TraceSpan): void {
    if (this.spans.length < MAX_SPANS) {
      this.spans.push(span);
      return;
    }
    // Counted, not silently dropped: a truncated trace must not read as complete.
    this.spansDropped += 1;
  }
}
