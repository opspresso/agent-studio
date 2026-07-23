import { randomUUID } from "node:crypto";
import type { EngineChunk, RunResult } from "@/domain/llm/types";
import type { TraceRepository } from "@/domain/trace/repository";
import type { Trace, TraceSpan } from "@/domain/trace/types";

const MAX_PREVIEW_CHARS = 1_000;
const MAX_SPANS = 100;

export interface TraceContext {
  projectName: string;
  versionName: string;
  projectType: string;
  model: string;
  messageCount: number;
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
  private readonly pendingTools = new Map<string, { name: string; startedAt: Date; inputChars: number }>();
  private readonly subagentStarted = new Map<string, { startedAt: Date; traceId?: string }>();
  private error: string | undefined;

  constructor(
    private readonly repository: TraceRepository,
    private readonly context: TraceContext,
  ) {}

  observe(chunk: EngineChunk): void {
    const now = new Date();
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
        startedAt: started.toISOString(),
        endedAt: now.toISOString(),
        durationMs: Math.max(0, now.getTime() - started.getTime()),
        status: chunk.toolResult.content.startsWith("Error:") ? "error" : "ok",
        input: pending ? { argumentChars: pending.inputChars } : undefined,
        output: { contentChars: chunk.toolResult.content.length },
      });
      this.pendingTools.delete(chunk.toolResult.toolCallId);
    }
    if (chunk.author) {
      const existing = this.subagentStarted.get(chunk.author);
      this.subagentStarted.set(chunk.author, {
        startedAt: existing?.startedAt ?? now,
        traceId: existing?.traceId ?? chunk.traceId,
      });
    }
    if (chunk.usage) {
      const modelStartedAt = this.modelStartedAt;
      this.addSpan({
        spanId: randomUUID(),
        kind: "model",
        name: this.context.model,
        author: chunk.author,
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
    if (chunk.error) {
      this.error = chunk.error;
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
    for (const [author, subagent] of this.subagentStarted) {
      this.addSpan({
        spanId: randomUUID(),
        kind: "subagent",
        name: author,
        author,
        startedAt: subagent.startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs: Math.max(0, endedAt.getTime() - subagent.startedAt.getTime()),
        status: this.error ? "error" : "ok",
        output: subagent.traceId ? { subagentTraceId: subagent.traceId } : undefined,
      });
    }
    const trace: Trace = {
      traceId: this.traceId,
      projectName: this.context.projectName,
      versionName: this.context.versionName,
      projectType: this.context.projectType,
      status: this.error ? "failed" : cancelled ? "cancelled" : "completed",
      spans: this.spans,
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
    }
  }
}
