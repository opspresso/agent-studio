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

import type { A2aClientKey, A2aClientKeyRepository } from "@/domain/a2a/clientKey";
import type { SecretCipher } from "@/domain/security/secretCipher";
import {
  ConflictError,
  isConditionalWriteFailure,
  NotFoundError,
  ValidationError,
} from "@/application/errors";
import { generateSecretValue, hashSecret } from "@/shared/generatedSecret";
import { isSlug, SLUG_RULE } from "@/domain/naming";
import { auditTarget, recordAudit } from "@/application/audit/recordAudit";
import { A2A_ACTOR_ID } from "@/domain/execution/actor";
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
  hasAny(): Promise<boolean>;
  reveal(name: string, actorEmail: string): Promise<{ key: string; createdAt: string }>;
  revoke(name: string, actorEmail: string): Promise<void>;
  /** The client name a raw key resolves to, or `null` for anything else. */
  verify(value: string): Promise<string | null>;
}

export const A2A_CLIENT_KEY_LIST_PAGE_SIZE = 100;

export async function listA2aClientKeys(
  repo: Pick<A2aClientKeyRepository, "list">,
): Promise<A2aClientKey[]> {
  const keys: A2aClientKey[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await repo.list(A2A_CLIENT_KEY_LIST_PAGE_SIZE, after);
    keys.push(...page);
    if (page.length < A2A_CLIENT_KEY_LIST_PAGE_SIZE) {
      return keys;
    }
    after = page.at(-1)!.name;
  }
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
      // The name becomes the actor id `a2a:{name}`. A client named after the
      // shared key's own actor id would be indistinguishable from it — merged
      // usage rows, the surface-wide concurrency ceiling instead of the
      // per-client one — which is the opposite of what a named key is for.
      if (name === A2A_ACTOR_ID) {
        throw new ValidationError(`"${A2A_ACTOR_ID}" is the shared key's actor id and is reserved`);
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
      const stored = await listA2aClientKeys(repo);
      return stored
        .map(toView)
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    async hasAny() {
      return (await repo.list(1)).length > 0;
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
      // The audit row and the 200 must mean the key is gone. A revoke that
      // found nothing is a 404, not a success that quietly left both rows —
      // and therefore the credential — in place.
      if (!(await repo.delete(name))) {
        throw new NotFoundError(`A2A client key "${name}" not found`);
      }
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
