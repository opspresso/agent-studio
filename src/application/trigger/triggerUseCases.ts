/**
 * Trigger configuration: the owner-gated CRUD behind the console.
 *
 * The delivery path is `runTrigger.ts`; this module never runs anything.
 */

import type { ProjectRepository } from "@/domain/project/repository";
import type { SecretCipher } from "@/domain/security/secretCipher";
import { isValidTimezone, parseCron } from "@/domain/trigger/cron";
import type { TriggerRepository } from "@/domain/trigger/repository";
import {
  PROJECT_WEBHOOK_ID,
  type ScheduleDelivery,
  type ScheduleTrigger,
  type Trigger,
  type TriggerKind,
  type TriggerRun,
  type WebhookTrigger,
} from "@/domain/trigger/types";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  isConditionalWriteFailure,
} from "@/application/errors";
import { assertProjectOwnerOrAdminReadable, assertProjectWritable } from "@/application/project/projectUseCases";
import { generateSecretValue } from "@/shared/generatedSecret";
import { log } from "@/shared/logger";
import { auditTarget, recordAudit } from "@/application/audit/recordAudit";
import { triggerSecretContext } from "@/domain/security/secretContext";
import { reviewRepositories, type GitHubReviewConfig } from "@/domain/trigger/pullRequestReview";

export interface TriggerDeps {
  triggers: TriggerRepository;
  projects: ProjectRepository;
  cipher: SecretCipher;
  /** Shared GitHub credentials may be delegated only by an installation administrator. */
  authorizeReview?: (email: string) => Promise<void>;
}

export interface CreateTriggerInput {
  githubReview?: GitHubReviewConfig | null;
  runAsOwner?: boolean;
  triggerId: string;
  /** Defaults to `webhook`, the kind that existed before there were two. */
  kind?: TriggerKind;
  description?: string;
  enabled?: boolean;
  allowConcurrent?: boolean;
  cron?: string;
  timezone?: string;
  message?: string;
  deliveries?: ScheduleDelivery[];
}

export interface UpdateTriggerInput {
  githubReview?: GitHubReviewConfig | null;
  runAsOwner?: boolean;
  description?: string;
  enabled?: boolean;
  allowConcurrent?: boolean;
  /** True re-issues the secret; the previous one stops working immediately. */
  rotateSecret?: boolean;
  cron?: string;
  timezone?: string;
  message?: string;
  deliveries?: ScheduleDelivery[];
}

/**
 * What a client sees: the union flattened to one serialisable shape, each
 * kind's fields present only on that kind. A webhook's secret is masked exactly
 * like every other stored credential, and returned in the clear only once —
 * from `create` and from a rotation, the two moments the caller has to copy it.
 */
export interface TriggerView {
  githubReview?: GitHubReviewConfig;
  executionEmail?: string;
  projectName: string;
  triggerId: string;
  kind: TriggerKind;
  description: string;
  enabled: boolean;
  allowConcurrent: boolean;
  createdAt: string;
  updatedAt: string;
  /** Webhook only. */
  secretMasked?: string;
  /** Present only on create/rotate. */
  secret?: string;
  /** Schedule only. */
  cron?: string;
  timezone?: string;
  message?: string;
  deliveries?: ScheduleDelivery[];
}

function toView(trigger: Trigger, cipher: SecretCipher, plaintext?: string): TriggerView {
  if (trigger.kind === "schedule") {
    return { ...trigger };
  }
  const { secret: _stored, ...rest } = trigger;
  return {
    ...rest,
    secretMasked: cipher.mask(_stored, triggerSecretContext(trigger.projectName, trigger.triggerId)),
    ...(plaintext ? { secret: plaintext } : {}),
  };
}

/** The cron and timezone rules, enforced where both create and update pass. */
function assertScheduleFields(input: { cron?: string; timezone?: string }): void {
  if (input.cron !== undefined && !parseCron(input.cron)) {
    throw new ValidationError(
      "cron must be a five-field cron expression (minute hour day-of-month month day-of-week)",
    );
  }
  if (input.timezone !== undefined && !isValidTimezone(input.timezone)) {
    throw new ValidationError(`Unknown timezone "${input.timezone}" — use an IANA zone name`);
  }
}

function cleanDeliveries(deliveries: readonly ScheduleDelivery[]): ScheduleDelivery[] {
  if (deliveries.length > 3) {
    throw new ValidationError("A schedule may deliver to at most three destinations");
  }
  const seen = new Set<string>();
  return deliveries.map((delivery) => {
    if (seen.has(delivery.kind)) {
      throw new ValidationError(`A schedule may name ${delivery.kind} only once`);
    }
    seen.add(delivery.kind);
    if (delivery.kind === "slack") {
      const channelId = delivery.channelId.trim();
      if (!channelId) {
        throw new ValidationError("A Slack destination needs a channel id");
      }
      return { kind: "slack", channelId };
    }
    if (delivery.kind === "telegram") {
      if (!Number.isSafeInteger(delivery.chatId) || delivery.chatId === 0) {
        throw new ValidationError("A Telegram destination needs a non-zero integer chat id");
      }
      if (
        delivery.threadId !== undefined &&
        (!Number.isSafeInteger(delivery.threadId) || delivery.threadId <= 0)
      ) {
        throw new ValidationError("A Telegram thread id must be a positive integer");
      }
      return {
        kind: "telegram",
        chatId: delivery.chatId,
        ...(delivery.threadId !== undefined ? { threadId: delivery.threadId } : {}),
      };
    }
    const conversationId = delivery.conversationId.trim();
    if (!conversationId) {
      throw new ValidationError("A Teams destination needs a conversation id");
    }
    return { kind: "teams", conversationId };
  });
}

/** `asw_…` — traceable to this product and to what it opens, like the others. */
function newSecret(): string {
  return generateSecretValue("triggerSecret");
}

export const TRIGGER_LIST_PAGE_SIZE = 100;

export async function listProjectTriggers(
  repo: Pick<TriggerRepository, "listByProject">,
  projectName: string,
): Promise<Trigger[]> {
  const triggers: Trigger[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await repo.listByProject(projectName, TRIGGER_LIST_PAGE_SIZE, after);
    triggers.push(...page);
    if (page.length < TRIGGER_LIST_PAGE_SIZE) {
      return triggers;
    }
    after = page.at(-1)!.triggerId;
  }
}

export function createTriggerUseCases(deps: TriggerDeps) {
  async function reviewConfig(value: GitHubReviewConfig | null | undefined, email: string): Promise<GitHubReviewConfig | undefined> {
    if (!value) return undefined;
    if (!deps.authorizeReview) throw new ForbiddenError("GitHub review configuration requires an administrator");
    await deps.authorizeReview(email);
    if (value.scope === "accessible") return { scope: "accessible" };
    const repositories = value.scope === "repositories" && reviewRepositories(value.repositories);
    if (!repositories) throw new ValidationError("Select accessible repositories or a non-empty list of exact owner/repo names");
    return { scope: "repositories", repositories };
  }
  async function load(projectName: string, triggerId: string): Promise<Trigger> {
    const trigger = await deps.triggers.get(projectName, triggerId);
    if (!trigger) {
      throw new NotFoundError(`Trigger "${triggerId}" not found`);
    }
    return trigger;
  }

  return {
    async list(projectName: string, userEmail: string): Promise<TriggerView[]> {
      await assertProjectOwnerOrAdminReadable(deps.projects, projectName, userEmail);
      const triggers = await listProjectTriggers(deps.triggers, projectName);
      return triggers.map((trigger) => toView(trigger, deps.cipher));
    },

    async create(
      projectName: string,
      input: CreateTriggerInput,
      userEmail: string,
    ): Promise<TriggerView> {
      const project = await assertProjectWritable(deps.projects, projectName, userEmail);
      if (input.runAsOwner && project.ownerEmail !== userEmail) throw new ForbiddenError("Only the owner can enable personal execution");
      if (input.runAsOwner !== undefined && input.kind !== "schedule") throw new ValidationError("Personal execution is only available for schedules");
      if (input.githubReview !== undefined && input.kind === "schedule") throw new ValidationError("GitHub reviews are only available for webhooks");
      const githubReview = await reviewConfig(input.githubReview, userEmail);
      // A project has exactly one webhook and it answers at `/api/webhook/{project}`,
      // which resolves this id and nothing else. Both halves of that are enforced
      // here, at the only place a row is minted: a webhook under any other name
      // would be a secret with no door, and a schedule under this one would make
      // the delivery endpoint 404 for a project whose console shows a webhook.
      if ((input.kind ?? "webhook") === "webhook") {
        if (input.triggerId !== PROJECT_WEBHOOK_ID) {
          throw new ValidationError(
            `A project's webhook is always "${PROJECT_WEBHOOK_ID}" — it is addressed by the project name`,
          );
        }
      } else if (input.triggerId === PROJECT_WEBHOOK_ID) {
        throw new ValidationError(`"${PROJECT_WEBHOOK_ID}" is reserved for the project's webhook`);
      }
      const now = new Date().toISOString();
      const base = {
        projectName,
        triggerId: input.triggerId,
        description: input.description ?? "",
        enabled: input.enabled ?? true,
        // Overlap is off unless asked for: a firing that comes faster than the
        // run takes would otherwise pile runs up until the cost guard notices.
        allowConcurrent: input.allowConcurrent ?? false,
        createdAt: now,
        updatedAt: now,
      };
      let trigger: Trigger;
      let secret: string | undefined;
      if (input.kind === "schedule") {
        if (input.cron === undefined || input.timezone === undefined) {
          throw new ValidationError("A schedule trigger needs a cron expression and a timezone");
        }
        assertScheduleFields(input);
        trigger = {
          ...base,
          kind: "schedule",
          ...(input.runAsOwner ? { executionEmail: userEmail } : {}),
          cron: input.cron,
          timezone: input.timezone,
          ...(input.message ? { message: input.message } : {}),
          ...(input.deliveries?.length
            ? { deliveries: cleanDeliveries(input.deliveries) }
            : {}),
        };
      } else {
        // The same refusal update gives: cron fields on a webhook are a caller
        // who meant kind: "schedule", and dropping them would mint a webhook
        // secret for a schedule that then silently never fires.
        if (
          input.cron !== undefined ||
          input.timezone !== undefined ||
          input.message !== undefined ||
          input.deliveries !== undefined
        ) {
          throw new ValidationError("Only a schedule trigger has cron, timezone, message or deliveries");
        }
        secret = newSecret();
        trigger = {
          ...base,
          kind: "webhook",
          secret: deps.cipher.encrypt(secret, triggerSecretContext(projectName, input.triggerId)),
          ...(githubReview ? { githubReview } : {}),
        };
      }
      try {
        await deps.triggers.create(trigger);
      } catch (error) {
        if (isConditionalWriteFailure(error, { includeTransaction: true })) {
          throw new ConflictError(`Trigger "${input.triggerId}" already exists`);
        }
        throw error;
      }
      return toView(trigger, deps.cipher, secret);
    },

    async update(
      projectName: string,
      triggerId: string,
      input: UpdateTriggerInput,
      userEmail: string,
    ): Promise<TriggerView> {
      const project = await assertProjectWritable(deps.projects, projectName, userEmail);
      if (input.runAsOwner && project.ownerEmail !== userEmail) throw new ForbiddenError("Only the owner can enable personal execution");
      const existing = await load(projectName, triggerId);
      if (input.githubReview !== undefined && existing.kind !== "webhook") throw new ValidationError("GitHub reviews are only available for webhooks");
      if (input.runAsOwner !== undefined && existing.kind !== "schedule") throw new ValidationError("Personal execution is only available for schedules");
      const shared = {
        description: input.description ?? existing.description,
        enabled: input.enabled ?? existing.enabled,
        allowConcurrent: input.allowConcurrent ?? existing.allowConcurrent,
        updatedAt: new Date().toISOString(),
      };
      if (existing.kind === "schedule") {
        // Explicit refusal over silent no-op: a caller asking a schedule for a
        // secret rotation is confused about what it is talking to.
        if (input.rotateSecret) {
          throw new ValidationError("A schedule trigger has no secret and no payload");
        }
        assertScheduleFields(input);
        // An empty string clears the message; undefined keeps what is stored.
        const { message: stored, deliveries: storedDeliveries, executionEmail: storedEmail, ...rest } = existing;
        const executionEmail = input.runAsOwner === undefined ? storedEmail : input.runAsOwner ? userEmail : undefined;
        const message = input.message ?? stored ?? "";
        const deliveries =
          input.deliveries === undefined
            ? (storedDeliveries ?? [])
            : cleanDeliveries(input.deliveries);
        const updated: ScheduleTrigger = {
          ...rest,
          ...shared,
          cron: input.cron ?? existing.cron,
          ...(executionEmail ? { executionEmail } : {}),
          timezone: input.timezone ?? existing.timezone,
          ...(message ? { message } : {}),
          ...(deliveries.length > 0 ? { deliveries } : {}),
        };
        await deps.triggers.put(updated);
        return toView(updated, deps.cipher);
      }
      if (
        input.cron !== undefined ||
        input.timezone !== undefined ||
        input.message !== undefined ||
        input.deliveries !== undefined
      ) {
        throw new ValidationError("Only a schedule trigger has cron, timezone, message or deliveries");
      }
      const rotated = input.rotateSecret ? newSecret() : undefined;
      const { githubReview: previousReview, ...storedWebhook } = existing;
      const githubReview = input.githubReview === undefined ? previousReview : await reviewConfig(input.githubReview, userEmail);
      const updated: WebhookTrigger = {
        ...storedWebhook,
        ...shared,
        ...(githubReview ? { githubReview } : {}),
        ...(rotated
          ? { secret: deps.cipher.encrypt(rotated, triggerSecretContext(projectName, triggerId)) }
          : {}),
      };
      await deps.triggers.put(updated);
      if (rotated) {
        await recordAudit({
          actorEmail: userEmail,
          action: "secret.rotate",
          target: auditTarget("project", projectName),
          detail: `webhook trigger secret '${triggerId}' reissued; the previous secret stopped working`,
        });
      }
      return toView(updated, deps.cipher, rotated);
    },

    /**
     * The secret in plaintext, for an owner or admin.
     *
     * Possible for the same reason a project API token is: it is stored
     * AES-encrypted rather than hashed, so it can be shown again instead of
     * forcing a rotation every time someone needs to re-copy it. The trade is
     * the same too — ciphertext plus `AES_ENCRYPTION_KEY` is enough to use one.
     */
    async reveal(
      projectName: string,
      triggerId: string,
      userEmail: string,
    ): Promise<{ secret: string; createdAt: string }> {
      await assertProjectWritable(deps.projects, projectName, userEmail);
      const trigger = await load(projectName, triggerId);
      if (trigger.kind !== "webhook") {
        throw new ValidationError("A schedule trigger has no secret");
      }
      // Secret access is worth a trail even when it is authorized — as a row
      // that can be queried later, and as a line that survives the audit store.
      log.warn(
        "trigger",
        `secret of trigger '${projectName}/${triggerId}' revealed by ${userEmail}`,
      );
      await recordAudit({
        actorEmail: userEmail,
        action: "secret.reveal",
        target: auditTarget("project", projectName),
        detail: `webhook trigger secret '${triggerId}'`,
      });
      return {
        secret: deps.cipher.decrypt(
          trigger.secret,
          triggerSecretContext(projectName, triggerId),
        ),
        createdAt: trigger.createdAt,
      };
    },

    async remove(projectName: string, triggerId: string, userEmail: string): Promise<void> {
      await assertProjectWritable(deps.projects, projectName, userEmail);
      const removed = await load(projectName, triggerId);
      await deps.triggers.delete(projectName, triggerId);
      // Only a webhook deletion is a revocation: its row *is* the credential, so
      // deleting it stops a secret from working. A schedule has none — twelve
      // lines up, revealing one is refused for exactly that reason — and
      // recording its deletion under `secret.revoke` would put rows that are not
      // credential removals into the filter an auditor uses to enumerate them.
      // The closed action set is what makes that filter trustworthy; widening
      // what one action means is the same drift as spelling `target` twice.
      if (removed.kind !== "webhook") {
        return;
      }
      await recordAudit({
        actorEmail: userEmail,
        action: "secret.revoke",
        target: auditTarget("project", projectName),
        detail: `webhook trigger '${triggerId}' deleted; its secret stopped working`,
      });
    },

    async runs(
      projectName: string,
      triggerId: string,
      limit: number,
      userEmail: string,
    ): Promise<TriggerRun[]> {
      // Owner/admin like traces: a delivery's result preview is runtime output.
      await assertProjectOwnerOrAdminReadable(deps.projects, projectName, userEmail);
      return deps.triggers.listRuns(projectName, triggerId, limit);
    },
  };
}
