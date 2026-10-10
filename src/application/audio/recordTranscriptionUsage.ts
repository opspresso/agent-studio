import type { AudioJob } from "@/domain/audio/job";
import type { TranscriptionResult } from "@/domain/llm/transcription";
import type { UsageRepository } from "@/domain/usage/repository";
import { actorKey } from "@/domain/execution/actor";
import { performanceSample } from "@/domain/usage/performance";
import { AudioJobStepError } from "./processJob";

/** Replaying a checkpoint must reproduce the exact bill and measurement snapshot. */
export async function recordTranscriptionUsage(
  usage: UsageRepository, job: Pick<AudioJob, "agentName" | "actor" | "user">, result: TranscriptionResult,
): Promise<void> {
  const accounting = result.accounting;
  if (!accounting || accounting.costUsd === undefined) throw new AudioJobStepError("transcription_cost_unknown", false);
  const measured = performanceSample(result.usage?.outputTokens ?? 0,
    result.usage?.outputTokens === undefined ? undefined : result.modelDurationMs);
  await usage.record({ agentName: job.agentName, date: accounting.date, model: result.model,
    calls: 1, inputTokens: result.usage?.inputTokens ?? 0, outputTokens: result.usage?.outputTokens ?? 0,
    costUsd: accounting.costUsd, idempotencyKey: accounting.eventId,
    ...(measured.timedCalls > 0 ? measured : {}),
    actor: actorKey(job.actor), userId: job.user.userId });
}
