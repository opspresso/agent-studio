import { randomUUID } from "node:crypto";
import type { EngineChunk, RunResult } from "@/domain/llm/types";
import type { TraceRepository } from "@/domain/trace/repository";
import type { Trace, TraceSpan } from "@/domain/trace/types";

const MAX_PREVIEW_CHARS = 1_000;
const MAX_SPANS = 100;
/** A run reports one warning per unusable binding; the item stays bounded. */
const MAX_WARNINGS = 20;

export interface TraceContext {
  projectName: string;
  versionName: string;
  projectType: string;
  model: string;
  messageCount: number;
  /** Transfer chain that reached this run, outermost first. */
  ancestry?: string[];
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
  /**
   * Keyed by the direct child + its trace id: one span per transfer this run
   * made (a deeper hop rolls into it), and two transfers to the same agent stay
   * two spans because each child run has its own trace id.
   */
  private readonly subagents = new Map<string, SubagentEntry>();
  private readonly warnings: string[] = [];
  private error: string | undefined;

  constructor(
    private readonly repository: TraceRepository,
    private readonly context: TraceContext,
  ) {}

  observe(chunk: EngineChunk): void {
    const now = new Date();
    if (chunk.warning && this.warnings.length < MAX_WARNINGS) {
      this.warnings.push(preview(chunk.warning));
    }
    for (const call of chunk.delta?.toolCalls ?? []) {
      const id = call.id;
      if (id) {
        this.pendingTools.set(id, {
          name: call.function?.name ?? "tool",
          startedAt: now,
          inputChars: call.function?.arguments?.length ?? 0,
        });
      }
    }
    if (chunk.toolResult) {
      const pending = this.pendingTools.get(chunk.toolResult.toolCallId);
      const started = pending?.startedAt ?? now;
      this.addSpan({
        spanId: chunk.toolResult.toolCallId,
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
      this.pendingTools.delete(chunk.toolResult.toolCallId);
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
          name: this.context.model,
          startedAt: modelStartedAt.toISOString(),
          endedAt: now.toISOString(),
          durationMs: Math.max(0, now.getTime() - modelStartedAt.getTime()),
          status: "ok",
          input: {
            messages: this.context.messageCount,
            inputTokens: chunk.usage.inputTokens,
          },
          output: {
            outputTokens: chunk.usage.outputTokens,
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
    const now = new Date();
    this.addSpan({
      spanId: randomUUID(),
      kind: "model",
      name: result.model,
      startedAt: this.startedAt.toISOString(),
      endedAt: now.toISOString(),
      durationMs: now.getTime() - this.startedAt.getTime(),
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
    if (thrown !== undefined) {
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
      versionName: this.context.versionName,
      projectType: this.context.projectType,
      ...(this.context.ancestry && this.context.ancestry.length > 1
        ? { ancestry: this.context.ancestry }
        : {}),
      status: this.error ? "failed" : cancelled ? "cancelled" : "completed",
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
    const path = chunk.authorPath ?? [author];
    // The hop this run made; anything below it belongs to the same transfer.
    const child = path[0] ?? author;
    const key = `${child}#${chunk.traceId ?? "-"}`;
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
