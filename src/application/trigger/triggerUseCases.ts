/**
 * Trigger configuration: the owner-gated CRUD behind the console.
 *
 * The delivery path is `runTrigger.ts`; this module never runs anything.
 */

import type { ProjectRepository } from "@/domain/project/repository";
import type { SecretCipher } from "@/domain/security/secretCipher";
import { isValidTimezone, parseCron } from "@/domain/trigger/cron";
import type { TriggerRepository } from "@/domain/trigger/repository";
import type {
  ScheduleTrigger,
  Trigger,
  TriggerKind,
  TriggerRun,
  TriggerPayloadMode,
  WebhookTrigger,
} from "@/domain/trigger/types";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  isConditionalWriteFailure,
} from "@/application/errors";
import { assertProjectWritable } from "@/application/project/projectUseCases";
import { generateSecretValue } from "@/shared/generatedSecret";
import { log } from "@/shared/logger";
import { auditTarget, recordAudit } from "@/application/audit/recordAudit";

export interface TriggerDeps {
  triggers: TriggerRepository;
  projects: ProjectRepository;
  cipher: SecretCipher;
}

export interface CreateTriggerInput {
  triggerId: string;
  /** Defaults to `webhook`, the kind that existed before there were two. */
  kind?: TriggerKind;
  description?: string;
  enabled?: boolean;
  variables?: Record<string, string>;
  payloadMode?: TriggerPayloadMode;
  allowConcurrent?: boolean;
  cron?: string;
  timezone?: string;
  message?: string;
}

export interface UpdateTriggerInput {
  description?: string;
  enabled?: boolean;
  variables?: Record<string, string>;
  payloadMode?: TriggerPayloadMode;
  allowConcurrent?: boolean;
  /** True re-issues the secret; the previous one stops working immediately. */
  rotateSecret?: boolean;
  cron?: string;
  timezone?: string;
  message?: string;
}

/**
 * What a client sees: the union flattened to one serialisable shape, each
 * kind's fields present only on that kind. A webhook's secret is masked exactly
 * like every other stored credential, and returned in the clear only once —
 * from `create` and from a rotation, the two moments the caller has to copy it.
 */
export interface TriggerView {
  projectName: string;
  triggerId: string;
  kind: TriggerKind;
  description: string;
  enabled: boolean;
  variables?: Record<string, string>;
  allowConcurrent: boolean;
  createdAt: string;
  updatedAt: string;
  /** Webhook only. */
  payloadMode?: TriggerPayloadMode;
  secretMasked?: string;
  /** Present only on create/rotate. */
  secret?: string;
  /** Schedule only. */
  cron?: string;
  timezone?: string;
  message?: string;
}

function toView(trigger: Trigger, cipher: SecretCipher, plaintext?: string): TriggerView {
  if (trigger.kind === "schedule") {
    return { ...trigger };
  }
  const { secret: _stored, ...rest } = trigger;
  return {
    ...rest,
    secretMasked: cipher.mask(_stored),
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

/** `asw_…` — traceable to this product and to what it opens, like the others. */
function newSecret(): string {
  return generateSecretValue("triggerSecret");
}

export function createTriggerUseCases(deps: TriggerDeps) {
  async function load(projectName: string, triggerId: string): Promise<Trigger> {
    const trigger = await deps.triggers.get(projectName, triggerId);
    if (!trigger) {
      throw new NotFoundError(`Trigger "${triggerId}" not found`);
    }
    return trigger;
  }

  return {
    async list(projectName: string, userEmail: string): Promise<TriggerView[]> {
      await assertProjectWritable(deps.projects, projectName, userEmail);
      const triggers = await deps.triggers.listByProject(projectName);
      return triggers.map((trigger) => toView(trigger, deps.cipher));
    },

    async create(
      projectName: string,
      input: CreateTriggerInput,
      userEmail: string,
    ): Promise<TriggerView> {
      await assertProjectWritable(deps.projects, projectName, userEmail);
      const now = new Date().toISOString();
      const base = {
        projectName,
        triggerId: input.triggerId,
        description: input.description ?? "",
        enabled: input.enabled ?? true,
        ...(input.variables ? { variables: input.variables } : {}),
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
        if (input.payloadMode !== undefined) {
          throw new ValidationError("A schedule trigger has no payload");
        }
        assertScheduleFields(input);
        trigger = {
          ...base,
          kind: "schedule",
          cron: input.cron,
          timezone: input.timezone,
          ...(input.message ? { message: input.message } : {}),
        };
      } else {
        // The same refusal update gives: cron fields on a webhook are a caller
        // who meant kind: "schedule", and dropping them would mint a webhook
        // secret for a schedule that then silently never fires.
        if (
          input.cron !== undefined ||
          input.timezone !== undefined ||
          input.message !== undefined
        ) {
          throw new ValidationError("Only a schedule trigger has cron, timezone or message");
        }
        secret = newSecret();
        trigger = {
          ...base,
          kind: "webhook",
          secret: deps.cipher.encrypt(secret),
          payloadMode: input.payloadMode ?? "message",
        };
      }
      try {
        await deps.triggers.create(trigger);
      } catch (error) {
        if (isConditionalWriteFailure(error)) {
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
      await assertProjectWritable(deps.projects, projectName, userEmail);
      const existing = await load(projectName, triggerId);
      const shared = {
        description: input.description ?? existing.description,
        enabled: input.enabled ?? existing.enabled,
        variables: input.variables ?? existing.variables,
        allowConcurrent: input.allowConcurrent ?? existing.allowConcurrent,
        updatedAt: new Date().toISOString(),
      };
      if (existing.kind === "schedule") {
        // Explicit refusal over silent no-op: a caller asking a schedule for a
        // secret rotation is confused about what it is talking to.
        if (input.rotateSecret || input.payloadMode !== undefined) {
          throw new ValidationError("A schedule trigger has no secret and no payload");
        }
        assertScheduleFields(input);
        // An empty string clears the message; undefined keeps what is stored.
        const { message: stored, ...rest } = existing;
        const message = input.message ?? stored ?? "";
        const updated: ScheduleTrigger = {
          ...rest,
          ...shared,
          cron: input.cron ?? existing.cron,
          timezone: input.timezone ?? existing.timezone,
          ...(message ? { message } : {}),
        };
        await deps.triggers.put(updated);
        return toView(updated, deps.cipher);
      }
      if (input.cron !== undefined || input.timezone !== undefined || input.message !== undefined) {
        throw new ValidationError("Only a schedule trigger has cron, timezone or message");
      }
      const rotated = input.rotateSecret ? newSecret() : undefined;
      const updated: WebhookTrigger = {
        ...existing,
        ...shared,
        payloadMode: input.payloadMode ?? existing.payloadMode,
        ...(rotated ? { secret: deps.cipher.encrypt(rotated) } : {}),
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
      return { secret: deps.cipher.decrypt(trigger.secret), createdAt: trigger.createdAt };
    },

    async remove(projectName: string, triggerId: string, userEmail: string): Promise<void> {
      await assertProjectWritable(deps.projects, projectName, userEmail);
      const removed = await load(projectName, triggerId);
      await deps.triggers.delete(projectName, triggerId);
      await recordAudit({
        actorEmail: userEmail,
        action: "secret.revoke",
        target: auditTarget("project", projectName),
        detail: `${removed.kind} trigger '${triggerId}' deleted`,
      });
    },

    async runs(
      projectName: string,
      triggerId: string,
      limit: number,
      userEmail: string,
    ): Promise<TriggerRun[]> {
      // Owner/admin like traces: a delivery's result preview is runtime output.
      await assertProjectWritable(deps.projects, projectName, userEmail);
      return deps.triggers.listRuns(projectName, triggerId, limit);
    },
  };
}

export type TriggerUseCases = ReturnType<typeof createTriggerUseCases>;
