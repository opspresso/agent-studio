/**
 * One trigger firing — a webhook delivery or a schedule occurrence.
 *
 * Everything a firing can be refused for is decided here and recorded the
 * same way: a run row with a status. An operator looking at the console should
 * be able to tell "it never fired" from "it fired and failed" without reading
 * logs, so a skip is a row too.
 *
 * The webhook-specific steps (secret, idempotency key, payload shaping) live in
 * `admitDelivery`/`payloadInput`; everything from "resolve the published
 * version" on is `admitRun`/`executeFiring`, shared with the schedule scan
 * (`scanSchedules.ts`) so the two kinds cannot drift on overlap policy, run
 * rows, or how an answer is previewed.
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
import type { Trigger, TriggerRun, WebhookTrigger } from "@/domain/trigger/types";
import { resolveRunnableVersion } from "@/application/project/resolveRunnableVersion";
import { RUN_LEASE_SECONDS } from "@/shared/runDeadline";
import { log } from "@/shared/logger";

/** Bounded preview of a run's answer, kept on the firing row. */
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

/** What `admitRun` reads: everything but the webhook secret's cipher. */
export type FiringDeps = Omit<TriggerRunnerDeps, "cipher">;

/** An admitted firing: everything `executeFiring` needs to proceed. */
export interface AdmittedFiring<T extends Trigger = Trigger> {
  status: "accepted";
  runId: string;
  trigger: T;
  project: Project;
  version: Version;
  run: TriggerRun;
  release: () => Promise<void>;
}

/** The webhook case, which is what `executeDelivery` takes. */
export type AdmittedDelivery = AdmittedFiring<WebhookTrigger>;

/** Why a delivery was refused, or everything the run needs to proceed. */
export type AdmitResult =
  | AdmittedDelivery
  | { status: "duplicate" }
  | { status: "disabled" }
  | { status: "not-configured" }
  | { status: "unauthorized" }
  | { status: "busy" }
  | { status: "no-published-version" };

/** The actor a firing is attributed to; the trigger kind is the actor kind. */
export function triggerActor(
  trigger: Pick<Trigger, "kind" | "projectName" | "triggerId">,
): RunActor {
  return { kind: trigger.kind, id: `${trigger.projectName}:${trigger.triggerId}` };
}

/** The overlap lease's key. Distinct from the actor's own slot partition. */
function overlapKey(projectName: string, triggerId: string): string {
  return `trigger-overlap:${projectName}:${triggerId}`;
}

/** What a firing row carries beyond its outcome: how it was deduplicated. */
interface FiringExtra {
  idempotencyKey?: string;
  scheduledFor?: string;
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
  if (trigger.kind !== "webhook") {
    // A schedule trigger has no delivery URL. Answering exactly like an unknown
    // trigger keeps the 404 from confirming the id exists.
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
  return admitRun(deps, trigger, idempotencyKey ? { idempotencyKey } : {});
}

/**
 * Admit a firing whose dedup claim is already won: resolve the published
 * version, guard overlap, and open the history row. Both kinds pass here.
 */
export async function admitRun<T extends Trigger>(
  deps: FiringDeps,
  trigger: T,
  extra: FiringExtra,
): Promise<
  | AdmittedFiring<T>
  | { status: "not-configured" }
  | { status: "busy" }
  | { status: "no-published-version" }
> {
  const project = await deps.projects.get(trigger.projectName);
  if (!project) {
    // A row too, like every refusal below: a schedule can outlive its project,
    // and "skipped: 1" in a scan summary with nothing in the history explaining
    // it is exactly what skip rows exist to prevent.
    await recordSkip(deps, trigger, extra, "Project not found.");
    return { status: "not-configured" };
  }
  // Published only. A draft is configuration in progress; an external system
  // firing at one would run whatever an editor happened to have saved.
  const version = await resolveRunnableVersion(deps.versions, project);
  if (!version) {
    await recordSkip(deps, trigger, extra, "No published version.");
    return { status: "no-published-version" };
  }

  let release = async () => {};
  if (!trigger.allowConcurrent && deps.runSlots) {
    const leaseUntil = Math.floor(Date.now() / 1000) + RUN_LEASE_SECONDS;
    const slot = await deps.runSlots.acquire(
      overlapKey(trigger.projectName, trigger.triggerId),
      1,
      leaseUntil,
    );
    if (!slot) {
      await recordSkip(
        deps,
        trigger,
        extra,
        "A run from this trigger was already in flight and overlap is not allowed.",
      );
      return { status: "busy" };
    }
    const slots = deps.runSlots;
    release = async () => {
      try {
        await slots.release(overlapKey(trigger.projectName, trigger.triggerId), slot);
      } catch (error) {
        // The lease expires on its own; a failed release costs one window, not
        // a permanently blocked trigger.
        log.warn("trigger", `could not release overlap lease for ${trigger.triggerId}`, error);
      }
    };
  }

  const run: TriggerRun = {
    projectName: trigger.projectName,
    triggerId: trigger.triggerId,
    runId: randomUUID(),
    status: "running",
    ...(extra.idempotencyKey ? { idempotencyKey: extra.idempotencyKey } : {}),
    ...(extra.scheduledFor ? { scheduledFor: extra.scheduledFor } : {}),
    startedAt: new Date().toISOString(),
  };
  try {
    await deps.triggers.appendRun(run);
  } catch (error) {
    // History is a log; losing a row must not cost the firing.
    log.error("trigger", "could not record the start of a firing", error);
  }
  return { status: "accepted", runId: run.runId, trigger, project, version, run, release };
}

/** A firing that never ran, recorded so the console can say why. */
export async function recordSkip(
  deps: FiringDeps,
  trigger: Pick<Trigger, "projectName" | "triggerId">,
  extra: FiringExtra,
  reason: string,
): Promise<void> {
  const now = new Date().toISOString();
  try {
    await deps.triggers.appendRun({
      projectName: trigger.projectName,
      triggerId: trigger.triggerId,
      runId: randomUUID(),
      status: "skipped",
      ...(extra.idempotencyKey ? { idempotencyKey: extra.idempotencyKey } : {}),
      ...(extra.scheduledFor ? { scheduledFor: extra.scheduledFor } : {}),
      startedAt: now,
      endedAt: now,
      error: reason,
    });
  } catch (error) {
    log.error("trigger", "could not record a skipped firing", error);
  }
}

/** Drive an admitted webhook delivery with its payload shaped for the run. */
export async function executeDelivery(
  deps: TriggerRunnerDeps,
  admitted: AdmittedDelivery,
  payload: unknown,
): Promise<void> {
  let input: { variables?: Record<string, string>; message?: string };
  try {
    input = payloadInput(admitted.trigger, payload);
  } catch (caught) {
    // Shaping the payload is part of the firing: a body the serialiser refuses
    // (deep nesting overflows JSON.stringify) must finish the row and release
    // the overlap slot like any other failure, or the trigger reads busy for a
    // whole lease and the row stays running forever.
    await admitted.release();
    await finishFiring(deps, admitted.run, {
      error: caught instanceof Error ? caught.message : String(caught),
    });
    return;
  }
  await executeFiring(deps, admitted, input);
}

/**
 * Drive an admitted firing to completion and finish its history row.
 *
 * Never throws: it runs after the response went out, so there is nobody left to
 * throw to. Everything it learns goes on the row instead.
 */
export async function executeFiring(
  deps: FiringDeps,
  admitted: AdmittedFiring,
  input: { variables?: Record<string, string>; message?: string },
): Promise<void> {
  const { trigger, project, version, run } = admitted;
  let text = "";
  let error: string | undefined;
  let traceId: string | undefined;
  // What the run reported without failing — a turn or budget limit, a binding
  // it could not use. A firing is unattended, so nobody watched the stream:
  // dropping these left a run the turn guard ended as a green `succeeded` row
  // while its own trace said `turn-limit`. Recorded beside the result rather
  // than as an error: the delivery did run, and a partial answer is not a
  // failure — but the row must say why it is partial.
  const warnings: string[] = [];
  try {
    for await (const chunk of deps.run({
      project,
      version,
      ...input,
      actor: triggerActor(trigger),
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
        if (chunk.warning) {
          warnings.push(chunk.warning);
        }
      }
      traceId ??= chunk.traceId;
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    await admitted.release();
  }
  await finishFiring(deps, run, {
    text,
    ...(error ? { error } : {}),
    ...(warnings.length > 0 ? { warning: warnings.join("\n") } : {}),
    ...(traceId ? { traceId } : {}),
  });
}

/** Close a firing's history row with whatever the attempt produced. */
async function finishFiring(
  deps: FiringDeps,
  run: TriggerRun,
  outcome: { text?: string; error?: string; warning?: string; traceId?: string },
): Promise<void> {
  const finished: TriggerRun = {
    ...run,
    status: outcome.error ? "failed" : "succeeded",
    endedAt: new Date().toISOString(),
    ...(outcome.text ? { result: outcome.text.slice(0, MAX_RESULT_CHARS) } : {}),
    ...(outcome.error ? { error: outcome.error.slice(0, MAX_RESULT_CHARS) } : {}),
    ...(outcome.warning ? { warning: outcome.warning.slice(0, MAX_RESULT_CHARS) } : {}),
    ...(outcome.traceId ? { traceId: outcome.traceId } : {}),
  };
  try {
    await deps.triggers.finishRun(finished);
  } catch (writeError) {
    log.error("trigger", "could not record the end of a firing", writeError);
  }
}
