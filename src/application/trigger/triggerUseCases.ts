/**
 * Trigger configuration: the owner-gated CRUD behind the console.
 *
 * The delivery path is `runTrigger.ts`; this module never runs anything.
 */

import type { ProjectRepository } from "@/domain/project/repository";
import type { SecretCipher } from "@/domain/security/secretCipher";
import type { TriggerRepository } from "@/domain/trigger/repository";
import type { TriggerRun, TriggerPayloadMode, WebhookTrigger } from "@/domain/trigger/types";
import { ConflictError, NotFoundError, isConditionalWriteFailure } from "@/application/errors";
import { assertProjectWritable } from "@/application/project/projectUseCases";
import { generateSecretValue } from "@/shared/generatedSecret";

export interface TriggerDeps {
  triggers: TriggerRepository;
  projects: ProjectRepository;
  cipher: SecretCipher;
}

export interface CreateTriggerInput {
  triggerId: string;
  description?: string;
  enabled?: boolean;
  variables?: Record<string, string>;
  payloadMode?: TriggerPayloadMode;
  allowConcurrent?: boolean;
}

export interface UpdateTriggerInput {
  description?: string;
  enabled?: boolean;
  variables?: Record<string, string>;
  payloadMode?: TriggerPayloadMode;
  allowConcurrent?: boolean;
  /** True re-issues the secret; the previous one stops working immediately. */
  rotateSecret?: boolean;
}

/**
 * What a client sees. The secret is masked exactly like every other stored
 * credential, and returned in the clear only once — from `create` and from a
 * rotation, which are the two moments the caller has to copy it.
 */
export interface TriggerView extends Omit<WebhookTrigger, "secret"> {
  secretMasked: string;
  /** Present only on create/rotate. */
  secret?: string;
}

function toView(trigger: WebhookTrigger, cipher: SecretCipher, plaintext?: string): TriggerView {
  const { secret: _stored, ...rest } = trigger;
  return {
    ...rest,
    secretMasked: cipher.mask(_stored),
    ...(plaintext ? { secret: plaintext } : {}),
  };
}

/** `asw_…` — traceable to this product and to what it opens, like the others. */
function newSecret(): string {
  return generateSecretValue("triggerSecret");
}

export function createTriggerUseCases(deps: TriggerDeps) {
  async function load(projectName: string, triggerId: string): Promise<WebhookTrigger> {
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
      const secret = newSecret();
      const trigger: WebhookTrigger = {
        projectName,
        triggerId: input.triggerId,
        kind: "webhook",
        description: input.description ?? "",
        enabled: input.enabled ?? true,
        secret: deps.cipher.encrypt(secret),
        ...(input.variables ? { variables: input.variables } : {}),
        payloadMode: input.payloadMode ?? "message",
        // Overlap is off unless asked for: a webhook that fires faster than the
        // run takes would otherwise pile runs up until the cost guard notices.
        allowConcurrent: input.allowConcurrent ?? false,
        createdAt: now,
        updatedAt: now,
      };
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
      const rotated = input.rotateSecret ? newSecret() : undefined;
      const updated: WebhookTrigger = {
        ...existing,
        description: input.description ?? existing.description,
        enabled: input.enabled ?? existing.enabled,
        variables: input.variables ?? existing.variables,
        payloadMode: input.payloadMode ?? existing.payloadMode,
        allowConcurrent: input.allowConcurrent ?? existing.allowConcurrent,
        ...(rotated ? { secret: deps.cipher.encrypt(rotated) } : {}),
        updatedAt: new Date().toISOString(),
      };
      await deps.triggers.put(updated);
      return toView(updated, deps.cipher, rotated);
    },

    async remove(projectName: string, triggerId: string, userEmail: string): Promise<void> {
      await assertProjectWritable(deps.projects, projectName, userEmail);
      await load(projectName, triggerId);
      await deps.triggers.delete(projectName, triggerId);
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
