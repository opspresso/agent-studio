import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { getDocumentClient, getTableName } from "./client";
import { queryAll } from "./query";
import { keys } from "./keys";
import { currentTenant } from "@/shared/tenantContext";

/**
 * CRUD over a name-keyed registry entity (single-item partition, SK `META`)
 * listed via its GSI1 `TYPE#<entityType>` partition. The `toItem`/`fromItem`
 * mappers stay per-repository — they carry the entity-specific fields.
 */
export function createKeyedRepository<T extends { name: string }>(opts: {
  entityType: Parameters<typeof keys.typePartition>[1];
  /** The tenant comes first, like every scoped builder — the helper supplies it. */
  key(tenant: string, name: string): { PK: string; SK: string };
  toItem(entity: T): Record<string, unknown>;
  fromItem(item: Record<string, unknown>): T;
}): {
  get(name: string): Promise<T | null>;
  list(): Promise<T[]>;
  create(entity: T): Promise<void>;
  update(entity: T): Promise<void>;
  put(entity: T): Promise<void>;
  delete(name: string): Promise<void>;
} {
  return {
    async get(name) {
      const res = await getDocumentClient().send(
        new GetCommand({ TableName: getTableName(), Key: opts.key(currentTenant(), name) }),
      );
      return res.Item ? opts.fromItem(res.Item) : null;
    },

    async list() {
      const items = await queryAll({
        TableName: getTableName(),
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": keys.typePartition(currentTenant(), opts.entityType) },
      });
      return items.map(opts.fromItem);
    },

    async put(entity) {
      await getDocumentClient().send(
        new PutCommand({ TableName: getTableName(), Item: opts.toItem(entity) }),
      );
    },

    async create(entity) {
      await getDocumentClient().send(
        new PutCommand({
          TableName: getTableName(),
          Item: opts.toItem(entity),
          ConditionExpression: "attribute_not_exists(PK)",
        }),
      );
    },

    async update(entity) {
      await getDocumentClient().send(
        new PutCommand({
          TableName: getTableName(),
          Item: opts.toItem(entity),
          ConditionExpression: "attribute_exists(PK)",
        }),
      );
    },

    async delete(name) {
      await getDocumentClient().send(
        new DeleteCommand({
          TableName: getTableName(),
          Key: opts.key(currentTenant(), name),
          ConditionExpression: "attribute_exists(PK)",
        }),
      );
    },
  };
}
