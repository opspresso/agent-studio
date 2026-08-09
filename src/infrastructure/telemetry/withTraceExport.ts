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
 * collector outage must not fail runs — the row in DynamoDB is the record.
 */
export function withTraceExport(
  repository: TraceRepository,
  exportTrace: (trace: Trace) => void | Promise<void>,
): TraceRepository {
  return {
    ...repository,
    async put(trace) {
      await repository.put(trace);
      try {
        await exportTrace(trace);
      } catch (error) {
        log.error("otel", "span export failed", error);
      }
    },
  };
}
