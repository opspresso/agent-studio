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
import { cutCodePoints } from "@/shared/utf8Text";
import type { RunActor } from "@/domain/execution/actor";
import type { RunSlotRepository } from "@/domain/execution/runSlot";
import type { EngineChunk } from "@/domain/llm/types";
import { collectedWarning, isTopLevelChunk } from "@/domain/llm/types";
import type { Project, Version } from "@/domain/project/types";
import type { ProjectRepository, VersionRepository } from "@/domain/project/repository";
import type { SecretCipher } from "@/domain/security/secretCipher";
import type { TriggerRepository } from "@/domain/trigger/repository";
import {
  PROJECT_WEBHOOK_ID,
  type ScheduleDelivery,
  type ScheduleDeliveryResult,
  type Trigger,
  type TriggerRun,
  type WebhookTrigger,
} from "@/domain/trigger/types";
import { resolveRunnableVersion } from "@/application/project/resolveRunnableVersion";
import { RUN_LEASE_SECONDS } from "@/shared/runDeadline";
import { log } from "@/shared/logger";
import { repairTriggerRuns } from "./repairLostRuns";

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
  /** Sends a completed schedule report; platform credentials stay in the composition root. */
  deliverReport?: (project: Project, delivery: ScheduleDelivery, text: string) => Promise<void>;
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
      ? `${cutCodePoints(serialised, MAX_PAYLOAD_CHARS)}\n…[payload truncated]`
      : serialised;
  return {
    ...(trigger.variables ? { variables: trigger.variables } : {}),
    message: body ? `Trigger payload:\n\n${body}` : "Trigger fired with no payload.",
  };
}

/**
 * Authenticate and admit a delivery to a project's webhook, or say why not.
 *
 * The project name is the whole address: a project has one webhook, stored
 * under `PROJECT_WEBHOOK_ID`, and this resolves it. No caller chooses which row
 * a delivery lands on, which is what makes "one webhook per project" a fact
 * about the code rather than a convention the routes agree to keep.
 *
 * Returns before the run happens: the caller acks, then drives `execute` in the
 * background. Splitting it this way is what lets a webhook sender get its
 * response in milliseconds while the run takes minutes.
 */
export async function admitDelivery(
  deps: TriggerRunnerDeps,
  projectName: string,
  presentedSecret: string | null,
  idempotencyKey: string | null,
): Promise<AdmitResult> {
  const trigger = await deps.triggers.get(projectName, PROJECT_WEBHOOK_ID);
  if (!trigger) {
    return { status: "not-configured" };
  }
  if (trigger.kind !== "webhook") {
    // `create` refuses to let a schedule take the id, so this is unreachable
    // through the API — but a row is not a type, and answering exactly like a
    // project with no webhook is the only safe reading of one that is wrong.
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
    const claimed = await deps.triggers.claimIdempotencyKey(
      projectName,
      PROJECT_WEBHOOK_ID,
      idempotencyKey,
    );
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
  // A delivery sweeps its own trigger on the way out, because the scheduler's
  // tick is the only other thing that ever does and a deployment may serve
  // webhooks with no ticker at all. It runs after the response has long gone and
  // after this delivery's own row is closed, so it costs the sender nothing and
  // never looks at the firing that started it: the cutoff is a whole lease in
  // the past. One bounded query per delivery is what that independence costs.
  await repairTriggerRuns(deps, admitted.trigger, new Date());
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
  // Pictures a firing produced. A trigger's row carries text, so the bytes have
  // nowhere to go — but a run that drew something and reported nothing wrote a
  // green `succeeded` row with an empty result, which reads exactly like a run
  // that produced nothing at all. An image project on a schedule is the whole
  // case: the picture is the answer, and the row was the only record of it.
  let images = 0;
  // Files a tool rendered. Named rather than counted, because unlike a picture
  // a file is usually the whole point of the firing — "the nightly report ran"
  // and "the nightly report produced report.docx" are different rows to the
  // person reading the history, and this row is their only record of it.
  const files: string[] = [];
  // Counted apart from the names above, which stop at `MAX_LISTED_FILES`. A
  // firing that rendered twenty-five documents reporting "Produced 10 files" is
  // a wrong number rather than a shortened list, and this row is the only place
  // anyone would have read either.
  let produced = 0;
  try {
    for await (const chunk of deps.run({
      project,
      version,
      ...input,
      actor: triggerActor(trigger),
    })) {
      // Top-level only for the answer, like every other consumer: a subagent's
      // text is not the run's answer (see `isTopLevelChunk`). What a child
      // *lost* is the run's loss, though — `collectedWarning` keeps authored
      // warnings, so the firing's row says why the answer is partial even when
      // a subagent was the one to say it.
      if (isTopLevelChunk(chunk)) {
        if (chunk.delta?.content) {
          text += chunk.delta.content;
        }
        if (chunk.error) {
          error = chunk.error;
        }
      }
      // Counted from subagent turns too, like `collectRun`'s: an image
      // subagent is how an agent project delegates drawing, and behind the
      // gate above that delegation closed as an empty `succeeded` row — the
      // exact state `imagesOnlyResult` exists to prevent.
      if (chunk.image) {
        images += 1;
      }
      // Counted from subagent turns too, exactly like the images above.
      if (chunk.file) {
        produced += 1;
        if (files.length < MAX_LISTED_FILES) {
          files.push(chunk.file.name);
        }
      }
      const warning = collectedWarning(chunk, warnings);
      if (warning) {
        warnings.push(warning);
      }
      traceId ??= chunk.traceId;
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    await admitted.release();
  }
  const deliveryResults: ScheduleDeliveryResult[] = [];
  if (!error && trigger.kind === "schedule" && trigger.deliveries?.length) {
    const report = text || (images > 0 ? imagesOnlyResult(images) : "");
    if (report) {
      const attempted = await Promise.all(
        trigger.deliveries.map(async (delivery): Promise<ScheduleDeliveryResult> => {
          try {
            if (!deps.deliverReport) {
              throw new Error("Schedule report delivery is unavailable");
            }
            await deps.deliverReport(project, delivery, report);
            return { kind: delivery.kind, status: "sent" };
          } catch (caught) {
            const message = caught instanceof Error ? caught.message : String(caught);
            warnings.push(`${delivery.kind} delivery failed: ${message}`);
            return {
              kind: delivery.kind,
              status: "failed",
              error: cutCodePoints(message, 500),
            };
          }
        }),
      );
      deliveryResults.push(...attempted);
    }
  }
  await finishFiring(deps, run, {
    // A picture is said only when the run produced nothing else to say: one
    // beside an answer is already accounted for by the answer, and one
    // *instead* of an answer is what would otherwise close as an empty success.
    //
    // A file is said either way, which is the asymmetry worth keeping. The
    // answer's own text almost always mentions the picture it drew; it says "I
    // have prepared the report" and never where the report went. A firing is
    // unattended, so this row is the only place anyone learns the name to look
    // for in the artifacts.
    text: producedNote(text || (images > 0 ? imagesOnlyResult(images) : text), produced, files),
    ...(error ? { error } : {}),
    ...(warnings.length > 0 ? { warning: warnings.join("\n") } : {}),
    ...(traceId ? { traceId } : {}),
    ...(deliveryResults.length > 0 ? { deliveryResults } : {}),
  });
}

/**
 * What a firing's row says when the run's whole answer was a picture.
 *
 * The row carries text and a trigger has nowhere to put bytes, so this is a
 * record that the run drew rather than the drawing. The usage row and the trace
 * carry the rest; without this line the history says `succeeded` with an empty
 * result, which is what a run that produced nothing looks like.
 */
function imagesOnlyResult(count: number): string {
  return `Generated ${count} image${count === 1 ? "" : "s"}. A trigger's history records text, so the image itself is not stored here.`;
}

/** How many produced files one row names before it stops listing them. */
const MAX_LISTED_FILES = 10;

/**
 * The answer with a line naming what the firing produced as files.
 *
 * A row carries text and a signature would be long expired by the time anyone
 * read this one, so the names are what it offers: enough to find the document
 * in the project's artifacts, which is where the bytes actually are.
 */
function producedNote(text: string, produced: number, files: readonly string[]): string {
  if (produced === 0) {
    return text;
  }
  // The count is the run's; the names are as many as the row will carry.
  const named = files.length < produced ? `${files.join(", ")}, …` : files.join(", ");
  const line = `Produced ${produced} file${produced === 1 ? "" : "s"}: ${named}. They are kept with the project's artifacts.`;
  if (!text) {
    return line;
  }
  // The answer yields the space, not the note. `finishFiring` cuts the whole
  // row at `MAX_RESULT_CHARS`, and this line is appended last — so on any run
  // whose answer is long enough to be cut, the one part naming the deliverable
  // would be the part that disappeared.
  const room = MAX_RESULT_CHARS - line.length - 2;
  const body = room > 0 ? cutCodePoints(text, room) : "";
  return body ? `${body}\n\n${line}` : line;
}

/** Close a firing's history row with whatever the attempt produced. */
async function finishFiring(
  deps: FiringDeps,
  run: TriggerRun,
  outcome: {
    text?: string;
    error?: string;
    warning?: string;
    traceId?: string;
    deliveryResults?: ScheduleDeliveryResult[];
  },
): Promise<void> {
  const finished: TriggerRun = {
    ...run,
    status: outcome.error ? "failed" : "succeeded",
    endedAt: new Date().toISOString(),
    // Cut on a character boundary: these land in a DynamoDB row, which will
    // not store a lone surrogate as written.
    ...(outcome.text ? { result: cutCodePoints(outcome.text, MAX_RESULT_CHARS) } : {}),
    ...(outcome.error ? { error: cutCodePoints(outcome.error, MAX_RESULT_CHARS) } : {}),
    ...(outcome.warning ? { warning: cutCodePoints(outcome.warning, MAX_RESULT_CHARS) } : {}),
    ...(outcome.traceId ? { traceId: outcome.traceId } : {}),
    ...(outcome.deliveryResults ? { deliveryResults: outcome.deliveryResults } : {}),
  };
  try {
    await deps.triggers.finishRun(finished);
  } catch (writeError) {
    log.error("trigger", "could not record the end of a firing", writeError);
  }
}
