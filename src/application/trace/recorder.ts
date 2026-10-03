import { randomUUID } from "node:crypto";
import { runTermination, isTopLevelChunk } from "@/domain/llm/types";
import type { EngineChunk } from "@/domain/llm/types";
import type { TraceRepository } from "@/domain/trace/repository";
import type { Trace, TraceSpan } from "@/domain/trace/types";
import type { RunActor, RunUser } from "@/domain/execution/actor";
import { linkTrace } from "@/shared/runContext";
import { cutCodePoints } from "@/shared/utf8Text";

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
  agentName: string;
  /** Transfer chain that reached this run, outermost first. */
  ancestry?: string[];
  /** Who caused the run; a subagent inherits its parent's. */
  actor?: RunActor;
  user?: RunUser;
  /** The conversation key (`conversationKey`) the run belongs to, when the surface has one. */
  conversation?: string;
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
    : `${cutCodePoints(value, MAX_PREVIEW_CHARS)}…`;
}

export class TraceRecorder {
  readonly traceId = randomUUID();
  private readonly startedAt = new Date();
  private readonly spans: TraceSpan[] = [];
  private spansDropped = 0;
  private readonly warnings: string[] = [];
  private error: string | undefined;
  /**
   * Whether this run stopped at a limit. Read from the top level only:
   * an authored termination is a child's, absorbed into the parent's tool
   * result, and must not mark the parent's trace.
   */
  private limit: "turn-limit" | "output-limit" | undefined;
  private awaitingApproval = false;

  observeSdkSpan(span: TraceSpan): void { this.addSpan(span); }

  constructor(
    private readonly repository: TraceRepository,
    private readonly context: TraceContext,
  ) {
    // Join request logs to the app Trace. Native child spans share this run.
    linkTrace(this.traceId);
  }

  /**
   * Record preparation separately from model time. The recorder exists before
   * preparation so failures still leave a trace. SDK spans own model/tool timing.
   */
  observePrepare(
    name: string,
    startedAt: Date,
    detail?: { status?: "ok" | "error"; output?: Record<string, unknown> },
  ): void {
    // The recorder owns payload bounds as well as span and warning counts.
    // Stage metadata must remain small when traces are stored and read whole.
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
  }

  observe(chunk: EngineChunk): void {
    if (chunk.warning && this.warnings.length < MAX_WARNINGS) {
      this.warnings.push(preview(chunk.warning));
    }
    const termination = runTermination(chunk);
    if (termination === "turn-limit" || termination === "output-limit") {
      this.limit = termination;
    }
    if (chunk.approval && isTopLevelChunk(chunk)) this.awaitingApproval = true;
    if (chunk.error && isTopLevelChunk(chunk)) this.error = chunk.error;
  }

  async finish(thrown?: unknown, cancelled = false): Promise<void> {
    const endedAt = new Date();
    if (cancelled) {
      this.error = undefined;
    } else if (thrown !== undefined) {
      this.error = thrown instanceof Error ? thrown.message : String(thrown);
    }
    const trace: Trace = {
      traceId: this.traceId,
      agentName: this.context.agentName,
      ...(this.context.ancestry && this.context.ancestry.length > 1
        ? { ancestry: this.context.ancestry }
        : {}),
      ...(this.context.actor ? { actor: this.context.actor } : {}),
      ...(this.context.user ? { user: this.context.user } : {}),
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

  private addSpan(span: TraceSpan): void {
    if (this.spans.length < MAX_SPANS) {
      this.spans.push(span);
      return;
    }
    // Counted, not silently dropped: a truncated trace must not read as complete.
    this.spansDropped += 1;
  }
}
