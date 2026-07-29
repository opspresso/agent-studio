/**
 * One webhook delivery.
 *
 * Everything a delivery can be refused for is decided here and recorded the
 * same way: a run row with a status. An operator looking at the console should
 * be able to tell "it never fired" from "it fired and failed" without reading
 * logs, so a skip is a row too.
 */

import { randomUUID } from "node:crypto";
import type { RunActor } from "@/domain/execution/actor";
import type { RunSlotRepository } from "@/domain/execution/runSlot";
import type { EngineChunk } from "@/domain/llm/types";
import { isTopLevelChunk } from "@/domain/llm/types";
import type { Project, Version } from "@/domain/project/types";
import type { ProjectRepository, VersionRepository } from "@/domain/project/repository";
import type { SecretCipher } from "@/domain/security/secretCipher";
import type { TriggerRepository } from "@/domain/trigger/repository";
import type { TriggerRun, WebhookTrigger } from "@/domain/trigger/types";
import { resolveRunnableVersion } from "@/application/project/resolveRunnableVersion";
import { RUN_LEASE_SECONDS } from "@/shared/runDeadline";
import { log } from "@/shared/logger";

/** Bounded preview of a run's answer, kept on the delivery row. */
const MAX_RESULT_CHARS = 2_000;
/** Bounded serialisation of a payload into the user message. */
const MAX_PAYLOAD_CHARS = 20_000;

export interface TriggerRunnerDeps {
  triggers: TriggerRepository;
  projects: ProjectRepository;
  versions: VersionRepository;
  cipher: SecretCipher;
  /** Runs the resolved version; the composition root binds the facade. */
  run: (input: {
    project: Project;
    version: Version;
    variables?: Record<string, string>;
    message?: string;
    actor: RunActor;
  }) => AsyncGenerator<EngineChunk>;
  /**
   * Reused to enforce `allowConcurrent: false` — "at most one in flight, and a
   * dead instance's hold expires" is exactly what a run slot already is.
   */
  runSlots?: RunSlotRepository;
}

/** Why a delivery was refused, or everything the run needs to proceed. */
export type AdmitResult =
  | {
      status: "accepted";
      runId: string;
      trigger: WebhookTrigger;
      project: Project;
      version: Version;
      run: TriggerRun;
      release: () => Promise<void>;
    }
  | { status: "duplicate" }
  | { status: "disabled" }
  | { status: "not-configured" }
  | { status: "unauthorized" }
  | { status: "busy" }
  | { status: "no-published-version" };

/** The accepted case, which is what `executeDelivery` takes. */
export type AdmittedDelivery = Extract<AdmitResult, { status: "accepted" }>;

/** The actor a trigger run is attributed to. */
export function triggerActor(projectName: string, triggerId: string): RunActor {
  return { kind: "webhook", id: `${projectName}:${triggerId}` };
}

/** The overlap lease's key. Distinct from the actor's own slot partition. */
function overlapKey(projectName: string, triggerId: string): string {
  return `trigger-overlap:${projectName}:${triggerId}`;
}

/**
 * Turn a delivery payload into what the run consumes.
 *
 * `variables` only reaches a prompt template, and only string values can be
 * substituted into one — a nested object rendered as `[object Object]` is worse
 * than not being offered. `message` carries the payload verbatim, which is what
 * an agent project can actually reason about.
 */
export function payloadInput(
  trigger: WebhookTrigger,
  payload: unknown,
): { variables?: Record<string, string>; message?: string } {
  if (trigger.payloadMode === "variables") {
    const flat: Record<string, string> = { ...(trigger.variables ?? {}) };
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          flat[key] = String(value);
        }
      }
    }
    return { variables: flat };
  }
  const serialised = payload === undefined ? "" : JSON.stringify(payload, null, 2);
  const body =
    serialised.length > MAX_PAYLOAD_CHARS
      ? `${serialised.slice(0, MAX_PAYLOAD_CHARS)}\n…[payload truncated]`
      : serialised;
  return {
    ...(trigger.variables ? { variables: trigger.variables } : {}),
    message: body ? `Trigger payload:\n\n${body}` : "Trigger fired with no payload.",
  };
}

/**
 * Authenticate and admit a delivery, or say why not.
 *
 * Returns before the run happens: the caller acks, then drives `execute` in the
 * background. Splitting it this way is what lets a webhook sender get its
 * response in milliseconds while the run takes minutes.
 */
export async function admitDelivery(
  deps: TriggerRunnerDeps,
  projectName: string,
  triggerId: string,
  presentedSecret: string | null,
  idempotencyKey: string | null,
): Promise<AdmitResult> {
  const trigger = await deps.triggers.get(projectName, triggerId);
  if (!trigger) {
    return { status: "not-configured" };
  }
  // The secret is checked before anything else observable happens, and in
  // constant time — a disabled trigger must not answer differently to a wrong
  // secret than an enabled one would.
  if (!presentedSecret || !deps.cipher.decryptEquals(trigger.secret, presentedSecret)) {
    return { status: "unauthorized" };
  }
  if (!trigger.enabled) {
    return { status: "disabled" };
  }
  if (idempotencyKey) {
    const claimed = await deps.triggers.claimIdempotencyKey(projectName, triggerId, idempotencyKey);
    if (!claimed) {
      return { status: "duplicate" };
    }
  }

  const project = await deps.projects.get(projectName);
  if (!project) {
    return { status: "not-configured" };
  }
  // Published only. A draft is configuration in progress; an external system
  // firing at one would run whatever an editor happened to have saved.
  const version = await resolveRunnableVersion(deps.versions, project);
  if (!version) {
    await recordSkip(deps, projectName, triggerId, idempotencyKey, "No published version.");
    return { status: "no-published-version" };
  }

  let release = async () => {};
  if (!trigger.allowConcurrent && deps.runSlots) {
    const leaseUntil = Math.floor(Date.now() / 1000) + RUN_LEASE_SECONDS;
    const slot = await deps.runSlots.acquire(overlapKey(projectName, triggerId), 1, leaseUntil);
    if (!slot) {
      await recordSkip(
        deps,
        projectName,
        triggerId,
        idempotencyKey,
        "A run from this trigger was already in flight and overlap is not allowed.",
      );
      return { status: "busy" };
    }
    const slots = deps.runSlots;
    release = async () => {
      try {
        await slots.release(overlapKey(projectName, triggerId), slot);
      } catch (error) {
        // The lease expires on its own; a failed release costs one window, not
        // a permanently blocked trigger.
        log.warn("trigger", `could not release overlap lease for ${triggerId}`, error);
      }
    };
  }

  const run: TriggerRun = {
    projectName,
    triggerId,
    runId: randomUUID(),
    status: "running",
    ...(idempotencyKey ? { idempotencyKey } : {}),
    startedAt: new Date().toISOString(),
  };
  try {
    await deps.triggers.appendRun(run);
  } catch (error) {
    // History is a log; losing a row must not cost the delivery.
    log.error("trigger", "could not record the start of a delivery", error);
  }
  return { status: "accepted", runId: run.runId, trigger, project, version, run, release };
}

/** A delivery that never ran, recorded so the console can say why. */
async function recordSkip(
  deps: TriggerRunnerDeps,
  projectName: string,
  triggerId: string,
  idempotencyKey: string | null,
  reason: string,
): Promise<void> {
  const now = new Date().toISOString();
  try {
    await deps.triggers.appendRun({
      projectName,
      triggerId,
      runId: randomUUID(),
      status: "skipped",
      ...(idempotencyKey ? { idempotencyKey } : {}),
      startedAt: now,
      endedAt: now,
      error: reason,
    });
  } catch (error) {
    log.error("trigger", "could not record a skipped delivery", error);
  }
}

/**
 * Drive an admitted delivery to completion and finish its history row.
 *
 * Never throws: it runs after the response went out, so there is nobody left to
 * throw to. Everything it learns goes on the row instead.
 */
export async function executeDelivery(
  deps: TriggerRunnerDeps,
  admitted: AdmittedDelivery,
  payload: unknown,
): Promise<void> {
  const { trigger, project, version, run } = admitted;
  let text = "";
  let error: string | undefined;
  let traceId: string | undefined;
  try {
    const input = payloadInput(trigger, payload);
    for await (const chunk of deps.run({
      project,
      version,
      ...input,
      actor: triggerActor(trigger.projectName, trigger.triggerId),
    })) {
      // Top-level only, like every other consumer: a subagent's text is not the
      // run's answer (see `isTopLevelChunk`).
      if (isTopLevelChunk(chunk)) {
        if (chunk.delta?.content) {
          text += chunk.delta.content;
        }
        if (chunk.error) {
          error = chunk.error;
        }
      }
      traceId ??= chunk.traceId;
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    await admitted.release();
  }
  const finished: TriggerRun = {
    ...run,
    status: error ? "failed" : "succeeded",
    endedAt: new Date().toISOString(),
    ...(text ? { result: text.slice(0, MAX_RESULT_CHARS) } : {}),
    ...(error ? { error: error.slice(0, MAX_RESULT_CHARS) } : {}),
    ...(traceId ? { traceId } : {}),
  };
  try {
    await deps.triggers.finishRun(finished);
  } catch (writeError) {
    log.error("trigger", "could not record the end of a delivery", writeError);
  }
}
