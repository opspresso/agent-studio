/**
 * DynamoDB A2A client-key repository. Each key is two rows written together:
 * the `A2ACLIENT#{name}` item (listed via the `TYPE#A2ACLIENT` GSI1 partition)
 * and an `A2AKEYHASH#{sha256}` item pointing back at the name — the
 * verification read runs on every inbound A2A request, so it must be one
 * GetItem, not a list-and-compare. The transaction is what keeps the pair from
 * ever half-existing.
 */

import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { getDocumentClient, getTableName } from "@/infrastructure/db/client";
import { queryAll } from "@/infrastructure/db/query";
import { keys } from "@/infrastructure/db/keys";
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
    // Consistent, like the sibling repositories: `delete` reads the hash to
    // remove through this, and a stale miss there would report a revocation
    // that left the credential alive.
    const result = await getDocumentClient().send(
      new GetCommand({
        TableName: getTableName(),
        Key: keys.a2aClientKey(name),
        ConsistentRead: true,
      }),
    );
    return result.Item ? fromItem(result.Item) : null;
  },

  async list() {
    const items = await queryAll({
      TableName: getTableName(),
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: { ":pk": keys.typePartition(ENTITY_TYPE) },
    });
    return items.map(fromItem);
  },

  async create(key) {
    await getDocumentClient().send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: getTableName(),
              Item: toItem(key),
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
          {
            Put: {
              TableName: getTableName(),
              Item: {
                ...keys.a2aClientKeyHash(key.tokenHash),
                entityType: "A2AKEYHASH",
                clientName: key.name,
              },
              // A hash collision here means the same secret was issued twice,
              // which `generateSecretValue`'s 256 random bits rule out — but a
              // failed condition must still refuse rather than repoint.
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
        ],
      }),
    );
  },

  async delete(name) {
    const stored = await this.get(name);
    if (!stored) {
      return false;
    }
    await getDocumentClient().send(
      new TransactWriteCommand({
        TransactItems: [
          { Delete: { TableName: getTableName(), Key: keys.a2aClientKey(name) } },
          { Delete: { TableName: getTableName(), Key: keys.a2aClientKeyHash(stored.tokenHash) } },
        ],
      }),
    );
    return true;
  },

  async findNameByHash(tokenHash) {
    const result = await getDocumentClient().send(
      new GetCommand({ TableName: getTableName(), Key: keys.a2aClientKeyHash(tokenHash) }),
    );
    return result.Item ? String(result.Item.clientName) : null;
  },
};
