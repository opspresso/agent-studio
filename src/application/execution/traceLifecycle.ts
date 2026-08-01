/** Trace recorder creation, sampling and termination for one run. */

import type { RunOrigin } from "@/domain/execution/actor";
import type { Project, Version } from "@/domain/project/types";
import type { TraceRepository } from "@/domain/trace/repository";
import { TraceRecorder } from "@/application/trace/recorder";
import type { ExecuteVersionInput, ExecutionDeps } from "./deps";
import { log } from "@/shared/logger";

/**
 * Whether this run's trace is recorded — the ONE place the sampling draw is
 * compared against the rate. The version path and the image path used to each
 * derive it, with opposite comparison operators; a third copy is exactly how
 * they would drift apart. `sample` is injected like `now` so a test can pin
 * the outcome at a fractional rate.
 */
export function traceSampled(
  deps: Pick<ExecutionDeps, "traces" | "traceSampleRate" | "sample">,
): boolean {
  return deps.traces !== undefined && (deps.sample ?? Math.random)() < (deps.traceSampleRate ?? 0);
}

export function sampledTraceRecorder(
  deps: ExecutionDeps,
  input: ExecuteVersionInput,
): TraceRecorder | undefined {
  if (!deps.traces || !traceSampled(deps)) {
    return undefined;
  }
  return createTraceRecorder(
    deps.traces,
    input.project,
    input.version,
    (input.extraMessages ?? input.messages ?? []).length,
    { ancestry: [input.project.name], ...(input.actor ? { actor: input.actor } : {}) },
  );
}

export function createTraceRecorder(
  traces: TraceRepository,
  project: Project,
  version: Version,
  messageCount: number,
  /** Who caused the run, and the transfer chain that reached it. */
  origin: RunOrigin,
): TraceRecorder {
  return new TraceRecorder(traces, {
    projectName: project.name,
    versionName: version.versionName,
    projectType: project.projectType,
    model: version.model,
    messageCount,
    ancestry: [...origin.ancestry],
    ...(origin.actor ? { actor: origin.actor } : {}),
  });
}

export async function finishTrace(
  recorder: TraceRecorder | undefined,
  error?: unknown,
  cancelled = false,
): Promise<void> {
  if (!recorder) {
    return;
  }
  try {
    await recorder.finish(error, cancelled);
  } catch (traceError) {
    log.error("trace", "persistence failed", traceError);
  }
}
