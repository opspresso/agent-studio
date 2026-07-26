/** Trace recorder creation, sampling and termination for one run. */

import type { Project, Version } from "@/domain/project/types";
import type { TraceRepository } from "@/domain/trace/repository";
import { TraceRecorder } from "@/application/trace/recorder";
import type { ExecuteVersionInput, ExecutionDeps } from "./deps";

export function sampledTraceRecorder(
  deps: ExecutionDeps,
  input: ExecuteVersionInput,
): TraceRecorder | undefined {
  if (!deps.traces || Math.random() >= (deps.traceSampleRate ?? 0)) {
    return undefined;
  }
  return createTraceRecorder(
    deps.traces,
    input.project,
    input.version,
    (input.extraMessages ?? input.messages ?? []).length,
  );
}

export function createTraceRecorder(
  traces: TraceRepository,
  project: Project,
  version: Version,
  messageCount: number,
  /** Transfer chain that reached this run, outermost first. */
  ancestry?: readonly string[],
): TraceRecorder {
  return new TraceRecorder(traces, {
    projectName: project.name,
    versionName: version.versionName,
    projectType: project.projectType,
    model: version.model,
    messageCount,
    ...(ancestry ? { ancestry: [...ancestry] } : {}),
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
    console.error("[trace] persistence failed", traceError);
  }
}
