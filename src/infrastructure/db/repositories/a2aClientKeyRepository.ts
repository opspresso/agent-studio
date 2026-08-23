/**
 * A2A client-key repository. Each key is two rows written together: the
 * `A2ACLIENT#{name}` item (listed via the `TYPE#A2ACLIENT` GSI1 partition)
 * and an `A2AKEYHASH#{sha256}` item pointing back at the name — the
 * verification read runs on every inbound A2A request, so it must be one
 * point read, not a list-and-compare. The transaction is what keeps the pair
 * from ever half-existing.
 */

import { keys } from "@/infrastructure/db/keys";
import { conditions, getItem, queryItems, transact } from "@/infrastructure/db/store";
import type { A2aClientKey, A2aClientKeyRepository } from "@/domain/a2a/clientKey";

const ENTITY_TYPE = "A2ACLIENT";

function toItem(key: A2aClientKey): Record<string, unknown> {
  return {
    ...keys.a2aClientKey(key.name),
    GSI1PK: keys.typePartition(ENTITY_TYPE),
    GSI1SK: key.name,
    entityType: ENTITY_TYPE,
    name: key.name,
    ...(key.description ? { description: key.description } : {}),
    token: key.token,
    tokenHash: key.tokenHash,
    masked: key.masked,
    createdAt: key.createdAt,
  };
}

function fromItem(item: Record<string, unknown>): A2aClientKey {
  return {
    name: String(item.name),
    ...(item.description ? { description: String(item.description) } : {}),
    token: String(item.token),
    tokenHash: String(item.tokenHash),
    masked: String(item.masked),
    createdAt: String(item.createdAt),
  };
}

export const a2aClientKeyRepository: A2aClientKeyRepository = {
  async get(name) {
    const item = await getItem(keys.a2aClientKey(name));
    return item ? fromItem(item) : null;
  },

  async list() {
    const items = await queryItems({ index: "GSI1", pk: keys.typePartition(ENTITY_TYPE) });
    return items.map(fromItem);
  },

  async create(key) {
    await transact([
      { kind: "put", item: toItem(key), condition: conditions.notExists },
      {
        kind: "put",
        item: {
          ...keys.a2aClientKeyHash(key.tokenHash),
          entityType: "A2AKEYHASH",
          clientName: key.name,
        },
        // A hash collision here means the same secret was issued twice, which
        // `generateSecretValue`'s 256 random bits rule out — but a failed
        // condition must still refuse rather than repoint.
        condition: conditions.notExists,
      },
    ]);
  },

  async delete(name) {
    const stored = await this.get(name);
    if (!stored) {
      return false;
    }
    await transact([
      { kind: "delete", key: keys.a2aClientKey(name) },
      { kind: "delete", key: keys.a2aClientKeyHash(stored.tokenHash) },
    ]);
    return true;
  },

  async findNameByHash(tokenHash) {
    const item = await getItem(keys.a2aClientKeyHash(tokenHash));
    return item ? String(item.clientName) : null;
  },
};
