import type { Trace } from "@/domain/trace/types";
import type { TraceRepository } from "@/domain/trace/repository";
import { log } from "@/shared/logger";

/**
 * Layers span export over the persistence port: `TraceRepository.put` is the
 * one seam every recorded run passes through, so decorating it needs no change
 * in `application/` and cannot miss a new entry point. Kept apart from the
 * OTEL adapter so the composition root can compose this without loading the
 * OTEL SDK — the exporter arrives as a (possibly lazily imported) function.
 *
 * `put` persists first, and an export failure is logged and swallowed: a
 * collector outage must not fail runs — the row in the database is the record.
 * What the catch sees is the enqueue path (a failed lazy import, a rejected
 * setup); the actual OTLP POST fails later inside the batch processor and is
 * reported through the OTEL diag channel, which the adapter routes to this
 * same log scope.
 *
 * The reads delegate method by method, not by spread: the wrapped repository
 * is a class instance, whose methods live on the prototype where a spread
 * cannot see them — the result would satisfy the type and lose every method
 * but `put`.
 */
export function withTraceExport(
  repository: TraceRepository,
  exportTrace: (trace: Trace) => void | Promise<void>,
): TraceRepository {
  return {
    async put(trace) {
      await repository.put(trace);
      try {
        await exportTrace(trace);
      } catch (error) {
        log.error("otel", "span export failed", error);
      }
    },
    get: (traceId) => repository.get(traceId),
    listByAgent: (agentName, options) => repository.listByAgent(agentName, options),
  };
}
