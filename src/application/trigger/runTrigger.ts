/**
 * One trigger firing — a webhook delivery or a schedule occurrence.
 *
 * Everything a firing can be refused for is decided here and recorded the
 * same way: a run row with a status. An operator looking at the console should
 * be able to tell "it never fired" from "it fired and failed" without reading
 * logs, so a skip is a row too.
 *
 * The webhook-specific steps (secret, idempotency key, payload shaping) live in
 * `admitDelivery`/`payloadInput`; everything from resolving current Agent
 * settings on is `admitRun`/`executeFiring`, shared with the schedule scan
 * (`scanSchedules.ts`) so the two kinds cannot drift on overlap policy, run
 * rows, or how an answer is previewed.
 */

import { randomUUID } from "node:crypto";
import { ForbiddenError, NotFoundError, ValidationError } from "@/application/errors";
import { resolveRunUser } from "@/application/auth/resolveRunUser";
import { assertWebhookExecutionGrant } from "@/application/auth/webhookAuthorization";
import { cutCodePoints } from "@/shared/utf8Text";
import type { RunActor, WebhookExecutionGrant } from "@/domain/execution/actor";
import { collectedWarning, isTopLevelChunk, runTermination, type RunTerminationReason } from "@/domain/llm/types";
import type { Agent, AgentConfiguration } from "@/domain/agent/types";
import {
  AGENT_WEBHOOK_ID,
  type ScheduleDeliveryResult,
  type ScheduleTrigger,
  type Trigger,
  type TriggerRun,
  type WebhookTrigger,
} from "@/domain/trigger/types";
import { RUN_LEASE_SECONDS } from "@/shared/runDeadline";
import { log } from "@/shared/logger";
import { repairTriggerRuns } from "./repairLostRuns";
import type { FiringDeps, TriggerRunnerDeps } from "./deps";
import { isGitHubDeliveryId } from "@/shared/githubWebhook";
import { holdQueuedFiring, queueLeaseUntil } from "./queuedFiring";
import { selectPullRequestReview, type PullRequestReviewTarget } from "@/domain/trigger/pullRequestReview";
import { preparePullRequestReview, type ReviewPublication } from "./reviewPullRequest";
import { reviewSetupIssue } from "./reviewRequirements";
import { holdRunningFiring, runningLease, type RunningFiring } from "./firingLease";

/** Bounded preview of a run's answer, kept on the firing row. */
const MAX_RESULT_CHARS = 2_000;
/** Bounded serialisation of a payload into the user message. */
const MAX_PAYLOAD_CHARS = 20_000;

/** An admitted firing: everything `executeFiring` needs to proceed. */
export interface AdmittedFiring<T extends Trigger = Trigger> extends RunningFiring {
  status: "accepted";
  runId: string;
  trigger: T;
  agent: Agent;
  configuration: AgentConfiguration;
  executionGrant?: WebhookExecutionGrant;
  /** Queued schedules fence their owner and record the real start before any effects. */
  start?: () => Promise<boolean>;
}

/** The webhook case, which is what `executeDelivery` takes. */
export type AdmittedDelivery = AdmittedFiring<WebhookTrigger> & {
  executionGrant: WebhookExecutionGrant;
  github?: { event: string; deliveryId: string };
  reviewTarget?: PullRequestReviewTarget;
};

export interface GitHubDeliveryCredential {
  kind: "github";
  credentialId: string | null;
  signature: string | null;
  body: string;
  deliveryId: string | null;
  event: string | null;
}

/** Why a delivery was refused, or everything the run needs to proceed. */
export type AdmitResult =
  | AdmittedDelivery
  | { status: "duplicate" }
  | { status: "disabled" }
  | { status: "not-configured" }
  | { status: "unauthorized" }
  | { status: "invalid-delivery" }
  | { status: "ping" }
  | { status: "ignored"; reason: string }
  | { status: "review-not-ready"; reason: string }
  | { status: "busy" }
  | { status: "no-configuration" };

/** The actor a firing is attributed to; the trigger kind is the actor kind. */
export function triggerActor(
  trigger: Pick<Trigger, "kind" | "agentName" | "triggerId">,
): RunActor {
  return { kind: trigger.kind, id: `${trigger.agentName}:${trigger.triggerId}` };
}

const EXECUTION_USER_UNAUTHORIZED = "The trigger execution user is no longer authorized.";

async function executionUserAllowed(deps: FiringDeps, trigger: Trigger, grant?: WebhookExecutionGrant): Promise<boolean> {
  try {
    if (trigger.kind === "schedule") {
      await resolveRunUser(deps, trigger.agentName, trigger.createdBy.userId);
    } else {
      if (!grant || grant.agentName !== trigger.agentName || grant.triggerId !== trigger.triggerId) return false;
      await assertWebhookExecutionGrant(deps, grant);
    }
    return true;
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof NotFoundError || error instanceof ValidationError) return false;
    throw error;
  }
}

async function resolveScheduleUser(deps: FiringDeps, schedule: ScheduleTrigger) {
  const current = await deps.triggers.get(schedule.agentName, schedule.triggerId);
  if (!current?.enabled || current.kind !== "schedule" ||
    current.createdBy.userId !== schedule.createdBy.userId || current.updatedAt !== schedule.updatedAt) {
    throw new ForbiddenError("The schedule changed before execution completed");
  }
  return resolveRunUser(deps, schedule.agentName, schedule.createdBy.userId);
}

/** The overlap lease's key. Distinct from the actor's own slot partition. */
function overlapKey(agentName: string, triggerId: string): string {
  return `trigger-overlap:${agentName}:${triggerId}`;
}

/** What a firing row carries beyond its outcome: how it was deduplicated. */
interface FiringExtra {
  userId?: string;
  idempotencyKey?: string;
  scheduledFor?: string;
  review?: TriggerRun["review"];
}

/** A webhook payload is framed as user data for the Agent. */
export function payloadInput(payload: unknown): { message: string } {
  const serialised = payload === undefined ? "" : JSON.stringify(payload, null, 2);
  const body =
    serialised.length > MAX_PAYLOAD_CHARS
      ? `${cutCodePoints(serialised, MAX_PAYLOAD_CHARS)}\n…[payload truncated]`
      : serialised;
  return {
    message: body ? `Trigger payload:\n\n${body}` : "Trigger fired with no payload.",
  };
}

/**
 * Authenticate and admit a delivery to an agent's webhook, or say why not.
 *
 * The agent name is the whole address: an agent has one webhook, stored
 * under `AGENT_WEBHOOK_ID`, and this resolves it. No caller chooses which row
 * a delivery lands on, which is what makes "one webhook per agent" a fact
 * about the code rather than a convention the routes agree to keep.
 *
 * Returns before the run happens: the caller acks, then drives `execute` in the
 * background. Splitting it this way is what lets a webhook sender get its
 * response in milliseconds while the run takes minutes.
 */
export async function admitDelivery(
  deps: TriggerRunnerDeps,
  agentName: string,
  presentedSecret: string | GitHubDeliveryCredential | null,
  idempotencyKey: string | null,
): Promise<AdmitResult> {
  const trigger = await deps.triggers.get(agentName, AGENT_WEBHOOK_ID);
  if (!trigger) {
    return { status: "not-configured" };
  }
  if (trigger.kind !== "webhook") {
    // `create` refuses to let a schedule take the id, so this is unreachable
    // through the API — but a row is not a type, and answering exactly like a
    // agent with no webhook is the only safe reading of one that is wrong.
    return { status: "not-configured" };
  }
  if (!presentedSecret) return { status: "unauthorized" };
  const user = await (typeof presentedSecret === "string"
    ? deps.webhookCredentials.verify(agentName, presentedSecret)
    : deps.webhookCredentials.verifySignature(agentName, presentedSecret.credentialId ?? "", presentedSecret.body, presentedSecret.signature))
    .catch(error => { if (error instanceof ForbiddenError) return null; throw error; });
  if (!user) return { status: "unauthorized" };
  const executionGrant: WebhookExecutionGrant = { ...user, kind: "webhook", agentName, triggerId: AGENT_WEBHOOK_ID };
  const github = typeof presentedSecret === "object" ? presentedSecret : undefined;
  if (trigger.githubReview && !github) return { status: "unauthorized" };
  if (github && (!isGitHubDeliveryId(github.deliveryId) || !github.event || !/^[a-z_]{1,80}$/.test(github.event))) {
    return { status: "invalid-delivery" };
  }
  if (!trigger.enabled) {
    return { status: "disabled" };
  }
  if (github?.event === "ping") return { status: "ping" };
  let reviewTarget: PullRequestReviewTarget | undefined;
  if (trigger.githubReview && github) {
    let payload: unknown;
    try { payload = JSON.parse(github.body); }
    catch { return { status: "ignored", reason: "Invalid pull request payload." }; }
    const selected = selectPullRequestReview(trigger.githubReview, github.event!, payload);
    if (selected.status === "ignored") return selected;
    reviewTarget = selected.target;
  }
  // A GitHub retry carries its original delivery ID. Do not let a different
  // optional generic key turn a redelivery into another model invocation.
  if (github) idempotencyKey = `github-delivery:${github.deliveryId}`;
  if (reviewTarget) idempotencyKey = `github-review:${reviewTarget.repository}:${reviewTarget.number}:${reviewTarget.headSha}`;
  let reviewAgent: Agent | null | undefined;
  if (reviewTarget) {
    reviewAgent = await deps.agents.get(agentName);
    let reason = reviewAgent ? reviewSetupIssue(reviewAgent) : "Agent not found.";
    if (!reason && (!deps.reviewForge || !deps.openReviewWorkspace)) reason = "PR review requires configured GitHub and Workspace integrations.";
    if (!reason && reviewAgent && !await executionUserAllowed(deps, trigger, executionGrant)) reason = EXECUTION_USER_UNAUTHORIZED;
    if (reason) {
      log.warn("trigger", "PR review setup is incomplete", { agentName, triggerId: trigger.triggerId, ...reviewTarget, reason });
      await recordSkip(deps, trigger, { userId: user.userId, review: { ...reviewTarget, status: "skipped", reason } }, reason);
      return { status: "review-not-ready", reason };
    }
  }
  if (idempotencyKey) {
    const claimed = await deps.triggers.claimIdempotencyKey(
      agentName,
      AGENT_WEBHOOK_ID,
      github ? idempotencyKey : JSON.stringify([user.userId, idempotencyKey]),
    );
    if (!claimed) {
      return { status: "duplicate" };
    }
  }
  const admitted = await admitRun(deps, trigger, { userId: user.userId, ...(idempotencyKey ? { idempotencyKey } : {}) }, { agent: reviewAgent, executionGrant });
  return admitted.status === "accepted"
    ? { ...admitted, executionGrant, ...(github ? { github: { event: github.event!, deliveryId: github.deliveryId! } } : {}), ...(reviewTarget ? { reviewTarget } : {}) }
    : admitted;

}

/**
 * Admit a firing whose dedup claim is already won: resolve current Agent
 * settings, guard overlap, and open the history row. Both kinds pass here.
 */
export async function admitRun<T extends Trigger>(
  deps: FiringDeps,
  trigger: T,
  extra: FiringExtra,
  options: { queued?: boolean; agent?: Agent | null; executionGrant?: WebhookExecutionGrant } = {},
): Promise<
  | AdmittedFiring<T>
  | { status: "not-configured" }
  | { status: "busy" }
  | { status: "no-configuration" }
> {
  const { queued = false } = options;
  const agent = options.agent === undefined ? await deps.agents.get(trigger.agentName) : options.agent;
  if (!agent) {
    // A row too, like every refusal below: a schedule can outlive its agent,
    // and "skipped: 1" in a scan summary with nothing in the history explaining
    // it is exactly what skip rows exist to prevent.
    await recordSkip(deps, trigger, extra, "Agent not found.");
    return { status: "not-configured" };
  }
  // Recheck the configured execution user's access before using current settings.
  if (!await executionUserAllowed(deps, trigger, options.executionGrant)) {
    await recordSkip(deps, trigger, extra, EXECUTION_USER_UNAUTHORIZED);
    return { status: "not-configured" };
  }
  const configuration = agent.configuration;
  if (!configuration) {
    await recordSkip(deps, trigger, extra, "Agent is not configured.");
    return { status: "no-configuration" };
  }

  let release = async () => {};
  let renewSlot = async () => true;
  if (!trigger.allowConcurrent && deps.runSlots) {
    const leaseUntil = Math.floor(Date.now() / 1000) + RUN_LEASE_SECONDS;
    const slot = await deps.runSlots.acquire(
      overlapKey(trigger.agentName, trigger.triggerId),
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
    renewSlot = () => slots.renew(overlapKey(trigger.agentName, trigger.triggerId), slot, Math.floor(Date.now() / 1000) + RUN_LEASE_SECONDS);
    release = async () => {
      try {
        await slots.release(overlapKey(trigger.agentName, trigger.triggerId), slot);
      } catch (error) {
        // The lease expires on its own; a failed release costs one window, not
        // a permanently blocked trigger.
        log.warn("trigger", `could not release overlap lease for ${trigger.triggerId}`, error);
      }
    };
  }

  const run: TriggerRun = {
    agentName: trigger.agentName,
    triggerId: trigger.triggerId,
    ...(trigger.kind === "schedule" ? { userId: trigger.createdBy.userId } : options.executionGrant ? { userId: options.executionGrant.userId } : {}),
    runId: randomUUID(),
    status: queued ? "queued" : "running",
    ...(extra.idempotencyKey ? { idempotencyKey: extra.idempotencyKey } : {}),
    ...(extra.scheduledFor ? { scheduledFor: extra.scheduledFor } : {}),
    ...(queued ? { queuedAt: new Date().toISOString(), queueLeaseUntil: queueLeaseUntil() } : { startedAt: new Date().toISOString() }),
    ...(!queued ? runningLease() : {}),
  };
  try {
    await deps.triggers.appendRun(run);
  } catch (error) {
    // Durable ownership must exist before any execution effect is allowed.
    await release();
    throw error;
  }
  const firing: AdmittedFiring<T> = { status: "accepted", runId: run.runId, trigger, agent, configuration, run, release, ...(options.executionGrant ? { executionGrant: options.executionGrant } : {}) };
  if (queued) holdQueuedFiring(deps, firing, renewSlot);
  else holdRunningFiring(deps, firing, renewSlot);
  return firing;
}

/** A firing that never ran, recorded so the console can say why. */
export async function recordSkip(
  deps: FiringDeps,
  trigger: Pick<Trigger, "agentName" | "triggerId">,
  extra: FiringExtra,
  reason: string,
): Promise<void> {
  const now = new Date().toISOString();
  try {
    await deps.triggers.appendRun({
      agentName: trigger.agentName,
      triggerId: trigger.triggerId,
      runId: randomUUID(),
      status: "skipped",
      ...(extra.idempotencyKey ? { idempotencyKey: extra.idempotencyKey } : {}),
      ...(extra.scheduledFor ? { scheduledFor: extra.scheduledFor } : {}),
      ...(extra.review ? { review: extra.review } : {}),
      ...(extra.userId ? { userId: extra.userId } : {}),
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
  try {
    let input: { message?: string; backgroundTask?: boolean; reviewSource?: Parameters<TriggerRunnerDeps["run"]>[0]["reviewSource"]; reviewWorkspace?: Parameters<TriggerRunnerDeps["run"]>[0]["reviewWorkspace"] };
    let publication: ReviewPublication | undefined;
    try {
      await admitted.check?.();
      if (admitted.reviewTarget) {
        const prepared = await preparePullRequestReview(deps, admitted.executionGrant,
          admitted.configuration, admitted.reviewTarget, admitted.check);
        if (prepared.status === "skipped") {
          await settleFiring(admitted, { skipped: true, text: prepared.reason,
            review: { ...admitted.reviewTarget, status: "skipped", reason: prepared.reason } });
          return;
        }
        admitted.configuration = prepared.configuration;
        input = { message: prepared.message, backgroundTask: true, reviewSource: prepared.readSource, reviewWorkspace: prepared.reviewWorkspace };
        publication = prepared.publication;
      } else input = payloadInput(payload);
      if (admitted.github && input.message && !publication) {
        input.message = `GitHub webhook delivery metadata (context only, not authorization): ${JSON.stringify(admitted.github)}\n\n${input.message}`;
      }
    } catch (caught) {
      // Shaping the payload is part of the firing: a body the serialiser refuses
      // (deep nesting overflows JSON.stringify) must finish the row and release
      // the overlap slot like any other failure, or the trigger reads busy for a
      // whole lease and the row stays running forever.
      await settleFiring(admitted, {
        error: caught instanceof Error ? caught.message : String(caught),
        ...(admitted.reviewTarget ? { review: { ...admitted.reviewTarget, status: "failed" as const,
          reason: "Pull request context could not be prepared; no review was published." } } : {}),
      });
      return;
    }
    await executeFiring(deps, admitted, input, publication);
  } finally {
    // A delivery sweeps its own trigger even when preparation skips or fails.
    // The ticker is optional, so this may be its only path to repair a lost run.
    await repairTriggerRuns(deps, admitted.trigger, new Date());
  }
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
  input: { message?: string; backgroundTask?: boolean; reviewSource?: Parameters<TriggerRunnerDeps["run"]>[0]["reviewSource"]; reviewWorkspace?: Parameters<TriggerRunnerDeps["run"]>[0]["reviewWorkspace"] },
  publication?: ReviewPublication,
): Promise<void> {
  if (admitted.start && !await admitted.start()) { await publication?.close(); return; }
  const { trigger, agent, configuration } = admitted;
  let text = "";
  let error: string | undefined;
  let traceId: string | undefined;
  let review: TriggerRun["review"];
  let termination: RunTerminationReason | undefined;
  // What the run reported without failing — a turn or budget limit, a binding
  // it could not use. A firing is unattended, so nobody watched the stream:
  // dropping these left a run the turn guard ended as a green `succeeded` row
  // while its own trace said `turn-limit`. Recorded beside the result rather
  // than as an error: the delivery did run, and a partial answer is not a
  // failure — but the row must say why it is partial.
  const warnings: string[] = [];
  // A trigger's history row is text; count generated images there so a run
  // whose only output is a picture still reports what it produced.
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
    await admitted.check?.();
    const user = trigger.kind === "schedule" ? await resolveScheduleUser(deps, trigger) : admitted.executionGrant;
    if (!user || (trigger.kind === "webhook" && !await executionUserAllowed(deps, trigger, admitted.executionGrant))) throw new Error(EXECUTION_USER_UNAUTHORIZED);
    for await (const chunk of deps.run({
      agent,
      configuration,
      ...input,
      actor: triggerActor(trigger),
      user: { userId: user.userId, email: user.email }, userEmail: user.email,
      executionGrant: trigger.kind === "schedule"
        ? { ...user, kind: "schedule", agentName: trigger.agentName, triggerId: trigger.triggerId, revision: trigger.updatedAt }
        : admitted.executionGrant!,
      ...(admitted.signal ? { signal: admitted.signal } : {}),
    })) {
      admitted.signal?.throwIfAborted();
      // Top-level only for the answer, like every other consumer: a subagent's
      // text is not the run's answer (see `isTopLevelChunk`). What a child
      // *lost* is the run's loss, though — `collectedWarning` keeps authored
      // warnings, so the firing's row says why the answer is partial even when
      // a subagent was the one to say it.
      if (isTopLevelChunk(chunk)) {
        termination = runTermination(chunk) ?? termination;
        if (chunk.delta?.content) {
          text += chunk.delta.content;
        }
        if (chunk.error) {
          error = chunk.error;
        }
        // Top-level only: an authored chunk's traceId is the child's trace,
        // and this row's contract is the trace of *this* run.
        traceId ??= chunk.traceId;
      }
      // Counted from subagent turns too, like `collectRun`'s: an image
      // subagent is how an agent delegates drawing, and behind the
      // gate above that delegation closed as an empty `succeeded` row — the
      // exact state `imagesOnlyResult` exists to prevent.
      // A fetched picture was read, not drawn — "Generated N images" must not
      // count a FetchUrl result as the firing's own work.
      if (chunk.image && !chunk.image.fetched) {
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
    }
    if (publication && !error) {
      if (termination !== "completed") throw new Error("The review run did not complete; no review was published");
      review = { ...publication.target, ...await publication.send(text, warnings) };
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    try { await publication?.close(); }
    catch (caught) { error = [error, caught instanceof Error ? caught.message : String(caught)].filter(Boolean).join("; "); }
  }
  if (publication && error && review?.status !== "posted") review = { ...publication.target, status: "failed", reason: cutCodePoints(error, 500) };
  const deliveryResults: ScheduleDeliveryResult[] = [];
  try {
    await admitted.check?.();
    if (!error && trigger.kind === "schedule" && trigger.deliveries?.length) {
      const report = text || (images > 0 ? imagesOnlyResult(images) : "");
      if (report) {
        const attempted = await Promise.all(
          trigger.deliveries.map(async (delivery): Promise<ScheduleDeliveryResult> => {
            try {
              if (!deps.deliverReport) {
                throw new Error("Schedule report delivery is unavailable");
              }
              await admitted.check?.();
              await resolveScheduleUser(deps, trigger);
              await deps.deliverReport(agent, delivery, report);
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
    await admitted.check?.();
  } catch (caught) {
    error = [error, caught instanceof Error ? caught.message : String(caught)].filter(Boolean).join("; ");
  }
  await settleFiring(admitted, {
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
    ...(review ? { review } : {}),
    ...(review?.status === "skipped" ? { skipped: true } : {}),
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
 * in the agent's artifacts, which is where the bytes actually are.
 */
function producedNote(text: string, produced: number, files: readonly string[]): string {
  if (produced === 0) {
    return text;
  }
  // The count is the run's; the names are as many as the row will carry.
  const named = files.length < produced ? `${files.join(", ")}, …` : files.join(", ");
  const line = `Produced ${produced} file${produced === 1 ? "" : "s"}: ${named}. They are kept with the agent's artifacts.`;
  if (!text) {
    return line;
  }
  // The answer yields the space, not the note. `settleFiring` cuts the whole
  // row at `MAX_RESULT_CHARS`, and this line is appended last — so on any run
  // whose answer is long enough to be cut, the one part naming the deliverable
  // would be the part that disappeared.
  const room = MAX_RESULT_CHARS - line.length - 2;
  const body = room > 0 ? cutCodePoints(text, room) : "";
  return body ? `${body}\n\n${line}` : line;
}

/** Hold the reservation through cleanup, delivery and terminal history persistence. */
async function settleFiring(
  admitted: AdmittedFiring,
  outcome: {
    text?: string;
    error?: string;
    warning?: string;
    traceId?: string;
    deliveryResults?: ScheduleDeliveryResult[];
    review?: TriggerRun["review"];
    skipped?: boolean;
  },
): Promise<void> {
  const { run } = admitted;
  const finished: TriggerRun = {
    ...run,
    status: outcome.error ? "failed" : outcome.skipped ? "skipped" : "succeeded",
    endedAt: new Date().toISOString(),
    // Cut on a character boundary: these land in a stored row, and a lone
    // surrogate does not survive the JSON round trip as written.
    ...(outcome.text ? { result: cutCodePoints(outcome.text, MAX_RESULT_CHARS) } : {}),
    ...(outcome.error ? { error: cutCodePoints(outcome.error, MAX_RESULT_CHARS) } : {}),
    ...(outcome.warning ? { warning: cutCodePoints(outcome.warning, MAX_RESULT_CHARS) } : {}),
    ...(outcome.traceId ? { traceId: outcome.traceId } : {}),
    ...(outcome.deliveryResults ? { deliveryResults: outcome.deliveryResults } : {}),
    ...(outcome.review ? { review: outcome.review } : {}),
  };
  if (outcome.error) {
    // Correlate the failure with stored details without logging provider text or source data.
    log.error("trigger", "firing failed; see trigger history", { agentName: run.agentName, triggerId: run.triggerId,
      runId: run.runId, ...(outcome.traceId ? { traceId: outcome.traceId } : {}),
      ...(outcome.review ? { repository: outcome.review.repository, number: outcome.review.number, headSha: outcome.review.headSha } : {}) });
  }
  try {
    if (!admitted.finish) throw new Error("Trigger execution ownership is not configured");
    if (!await admitted.finish(finished)) log.warn("trigger", "firing settlement lost its execution owner", { agentName: run.agentName, triggerId: run.triggerId, runId: run.runId });
  } catch (writeError) {
    log.error("trigger", "could not record the end of a firing", writeError);
  } finally {
    await admitted.release();
  }
}
