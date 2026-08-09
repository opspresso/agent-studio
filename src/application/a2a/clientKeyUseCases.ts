/**
 * Named inbound-A2A client keys. The shared `A2A_API_KEY` authenticates every
 * machine caller as one anonymous identity; a client key names its holder —
 * the actor becomes `a2a:{name}`, so attribution and the per-caller
 * concurrency limit work per client, and revoking one client does not rotate
 * everyone else.
 *
 * The lifecycle mirrors the project API token (`apiTokenUseCases.ts`): issued
 * once in plaintext, stored encrypted with a display mask, revealable and
 * revocable with an audit row each. Verification is by hash lookup — one
 * GetItem on the hot path — which the repository keeps in step with the key
 * row transactionally.
 */

import type { A2aClientKeyRepository } from "@/domain/a2a/clientKey";
import type { SecretCipher } from "@/domain/security/secretCipher";
import {
  ConflictError,
  isConditionalWriteFailure,
  NotFoundError,
  ValidationError,
} from "@/application/errors";
import { generateSecretValue, hashSecret } from "@/shared/generatedSecret";
import { isSlug, SLUG_RULE } from "@/shared/slug";
import { auditTarget, recordAudit } from "@/application/audit/recordAudit";
import { log } from "@/shared/logger";

export interface A2aClientKeyView {
  name: string;
  description?: string;
  masked: string;
  createdAt: string;
}

function toView(key: {
  name: string;
  description?: string;
  masked: string;
  createdAt: string;
}): A2aClientKeyView {
  return {
    name: key.name,
    ...(key.description ? { description: key.description } : {}),
    masked: key.masked,
    createdAt: key.createdAt,
  };
}

export interface A2aClientKeyUseCases {
  /** Issue a key for a new client. The raw value is returned exactly once. */
  create(
    name: string,
    description: string | undefined,
    actorEmail: string,
  ): Promise<{ key: string; view: A2aClientKeyView }>;
  list(): Promise<A2aClientKeyView[]>;
  reveal(name: string, actorEmail: string): Promise<{ key: string; createdAt: string }>;
  revoke(name: string, actorEmail: string): Promise<void>;
  /** The client name a raw key resolves to, or `null` for anything else. */
  verify(value: string): Promise<string | null>;
}

export function createA2aClientKeyUseCases(
  repo: A2aClientKeyRepository,
  cipher: SecretCipher,
): A2aClientKeyUseCases {
  return {
    async create(name, description, actorEmail) {
      if (!isSlug(name)) {
        throw new ValidationError(`name ${SLUG_RULE}`);
      }
      const value = generateSecretValue("a2aClientKey");
      const key = {
        name,
        ...(description?.trim() ? { description: description.trim() } : {}),
        token: cipher.encrypt(value),
        tokenHash: hashSecret(value),
        masked: cipher.mask(value),
        createdAt: new Date().toISOString(),
      };
      try {
        await repo.create(key);
      } catch (error) {
        if (isConditionalWriteFailure(error, { includeTransaction: true })) {
          throw new ConflictError(`A2A client key "${name}" already exists`);
        }
        throw error;
      }
      await recordAudit({
        actorEmail,
        action: "secret.rotate",
        target: auditTarget("a2a-client", name),
        detail: "client key issued",
      });
      return { key: value, view: toView(key) };
    },

    async list() {
      const stored = await repo.list();
      return stored
        .map(toView)
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    async reveal(name, actorEmail) {
      const stored = await repo.get(name);
      if (!stored) {
        throw new NotFoundError(`A2A client key "${name}" not found`);
      }
      // Secret access is worth a trail even when it is authorized — the line
      // survives an audit-store failure, the row is queryable.
      log.warn("a2a", `client key '${name}' revealed by ${actorEmail}`);
      await recordAudit({
        actorEmail,
        action: "secret.reveal",
        target: auditTarget("a2a-client", name),
        detail: "client key",
      });
      return { key: cipher.decrypt(stored.token), createdAt: stored.createdAt };
    },

    async revoke(name, actorEmail) {
      await repo.delete(name);
      await recordAudit({
        actorEmail,
        action: "secret.revoke",
        target: auditTarget("a2a-client", name),
        detail: "client key",
      });
    },

    verify(value) {
      return repo.findNameByHash(hashSecret(value));
    },
  };
}
