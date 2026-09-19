/** Trace recorder creation and termination for one run. */

import { conversationKey, type RunOrigin } from "@/domain/execution/actor";
import type { Project, AgentConfiguration } from "@/domain/project/types";
import type { TraceRepository } from "@/domain/trace/repository";
import { TraceRecorder } from "@/application/trace/recorder";
import { log } from "@/shared/logger";

export function createTraceRecorder(
  traces: TraceRepository,
  project: Project,
  configuration: AgentConfiguration,
  messageCount: number,
  /** Who caused the run, and the transfer chain that reached it. */
  origin: RunOrigin,
): TraceRecorder {
  return new TraceRecorder(traces, {
    projectName: project.name,
    projectType: project.projectType,
    model: configuration.model,
    messageCount,
    ancestry: [...origin.ancestry],
    ...(origin.actor ? { actor: origin.actor } : {}),
    ...(origin.conversation ? { conversation: conversationKey(origin.conversation) } : {}),
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
