/** Trace recorder creation, sampling and termination for one run. */

import { conversationKey, type RunActor, type RunConversation, type RunOrigin } from "@/domain/execution/actor";
import type { ChatMessageInput } from "@/domain/llm/types";
import type { Project, Version } from "@/domain/project/types";
import type { TraceRepository } from "@/domain/trace/repository";
import { TraceRecorder } from "@/application/trace/recorder";
import { log } from "@/shared/logger";

/**
 * What sampling reads, stated structurally rather than as a `Pick` of
 * `ExecutionDeps`: this slice sits beneath the execution facade (the image use
 * case reaches it without going through `runProject`), so naming the facade's
 * deps here would point the graph back at the layer above. `ExecutionDeps` and
 * `ImageGenerationDeps` both satisfy it by shape.
 */
export interface TraceSamplingDeps {
  traces?: TraceRepository;
  traceSampleRate?: number;
  /** The sampling draw, injected like `now`; unset means `Math.random`. */
  sample?: () => number;
}

/**
 * The slice of a version run's input the recorder reads — structurally
 * satisfied by `ExecuteVersionInput`, for the same reason as
 * {@link TraceSamplingDeps}.
 */
interface TracedRunInput {
  project: Project;
  version: Version;
  extraMessages?: ChatMessageInput[];
  messages?: ChatMessageInput[];
  actor?: RunActor;
  conversation?: RunConversation;
}

/**
 * Whether this run's trace is recorded — the ONE place the sampling draw is
 * compared against the rate. The version path and the image path used to each
 * derive it, with opposite comparison operators; a third copy is exactly how
 * they would drift apart. `sample` is injected like `now` so a test can pin
 * the outcome at a fractional rate.
 */
export function traceSampled(deps: TraceSamplingDeps): boolean {
  return deps.traces !== undefined && (deps.sample ?? Math.random)() < (deps.traceSampleRate ?? 0);
}

export function sampledTraceRecorder(
  deps: TraceSamplingDeps,
  input: TracedRunInput,
): TraceRecorder | undefined {
  if (!deps.traces || !traceSampled(deps)) {
    return undefined;
  }
  return createTraceRecorder(
    deps.traces,
    input.project,
    input.version,
    (input.extraMessages ?? input.messages ?? []).length,
    {
      ancestry: [input.project.name],
      ...(input.actor ? { actor: input.actor } : {}),
      ...(input.conversation ? { conversation: input.conversation } : {}),
    },
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
