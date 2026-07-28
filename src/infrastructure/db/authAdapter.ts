import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { createAdapter } from "better-auth/adapters";
import { getDocumentClient, getTableName } from "@/infrastructure/db/client";
import { keys } from "@/infrastructure/db/keys";
import { expiresAtFromIso } from "@/infrastructure/db/ttl";

type Where = {
  field: string;
  value: unknown;
  operator?: string;
  connector?: "AND" | "OR";
};

/** Fields with a GSI2 unique-lookup item per model. */
const UNIQUE_FIELDS: Record<string, string[]> = {
  user: ["email"],
  session: ["token"],
  verification: ["identifier"],
};

type Item = Record<string, unknown>;

/**
 * Where the ISO `expiresAt` Better Auth wrote is parked while the attribute of
 * that name carries the unix-seconds TTL the table expires on. `supportsDates`
 * is off, so Better Auth hands us — and expects back — an ISO string; DynamoDB
 * only collects a *Number*, and silently ignores any other type. Storing the
 * string under the TTL attribute is therefore not a type mismatch anything
 * reports: session and verification rows simply accumulate forever.
 */
const EXPIRES_AT_ISO = "expiresAtIso";

function uniqueFieldFor(model: string, data: Item): string | undefined {
  return (UNIQUE_FIELDS[model] ?? []).find((field) => data[field] !== undefined);
}

function uniqueLock(model: string, data: Item): Item | undefined {
  const field = uniqueFieldFor(model, data);
  if (!field) {
    return undefined;
  }
  const value = String(data[field]);
  return {
    ...keys.authUnique(model, field, value),
    entityType: "auth:unique",
    model,
    field,
    value,
    targetId: String(data.id),
  };
}

function toRecord(item: Item): Item {
  const { PK, SK, GSI1PK, GSI1SK, GSI2PK, GSI2SK, entityType, ...rest } = item;
  void PK, SK, GSI1PK, GSI1SK, GSI2PK, GSI2SK, entityType;
  const iso = rest[EXPIRES_AT_ISO];
  delete rest[EXPIRES_AT_ISO];
  // Hand Better Auth back the ISO instant it wrote, not the numeric TTL that
  // replaced it. Rows written before the split carry no `expiresAtIso` and keep
  // their string `expiresAt`, so they still read correctly — they just stay
  // uncollected until a session refresh rewrites them.
  return typeof iso === "string" ? { ...rest, expiresAt: iso } : rest;
}

function matchesClause(record: Item, clause: Where): boolean {
  const actual = record[clause.field];
  const expected = clause.value;
  switch (clause.operator ?? "eq") {
    case "eq":
      return actual === expected;
    case "ne":
      return actual !== expected;
    case "in":
      return Array.isArray(expected) && expected.includes(actual);
    case "contains":
      return typeof actual === "string" && typeof expected === "string" && actual.includes(expected);
    case "starts_with":
      return typeof actual === "string" && typeof expected === "string" && actual.startsWith(expected);
    case "ends_with":
      return typeof actual === "string" && typeof expected === "string" && actual.endsWith(expected);
    case "lt":
      return (actual as never) < (expected as never);
    case "lte":
      return (actual as never) <= (expected as never);
    case "gt":
      return (actual as never) > (expected as never);
    case "gte":
      return (actual as never) >= (expected as never);
    default:
      return actual === expected;
  }
}

function matchesWhere(record: Item, where: Where[]): boolean {
  const andClauses = where.filter((w) => (w.connector ?? "AND") === "AND");
  const orClauses = where.filter((w) => w.connector === "OR");
  const andOk = andClauses.every((w) => matchesClause(record, w));
  const orOk = orClauses.length === 0 || orClauses.some((w) => matchesClause(record, w));
  return andOk && orOk;
}

async function queryPartition(
  indexName: "GSI1" | "GSI2",
  partitionKey: string,
  partitionValue: string,
): Promise<Item[]> {
  const client = getDocumentClient();
  const items: Item[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(
      new QueryCommand({
        TableName: getTableName(),
        IndexName: indexName,
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: { "#pk": partitionKey },
        ExpressionAttributeValues: { ":pk": partitionValue },
        ExclusiveStartKey: lastKey,
      }),
    );
    items.push(...((result.Items ?? []) as Item[]));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

async function findRecords(model: string, where: Where[]): Promise<Item[]> {
  const client = getDocumentClient();

  const idClause = where.find(
    (w) => w.field === "id" && (w.operator ?? "eq") === "eq" && (w.connector ?? "AND") === "AND",
  );
  if (idClause) {
    const result = await client.send(
      new GetCommand({ TableName: getTableName(), Key: keys.auth(model, String(idClause.value)) }),
    );
    if (!result.Item) return [];
    const record = toRecord(result.Item as Item);
    return matchesWhere(record, where) ? [record] : [];
  }

  const uniqueClause = where.find(
    (w) =>
      (UNIQUE_FIELDS[model] ?? []).includes(w.field) &&
      (w.operator ?? "eq") === "eq" &&
      (w.connector ?? "AND") === "AND",
  );
  if (uniqueClause) {
    const lock = await client.send(
      new GetCommand({
        TableName: getTableName(),
        Key: keys.authUnique(model, uniqueClause.field, String(uniqueClause.value)),
        ConsistentRead: true,
      }),
    );
    const targetId = lock.Item?.targetId;
    if (targetId !== undefined) {
      const result = await client.send(
        new GetCommand({
          TableName: getTableName(),
          Key: keys.auth(model, String(targetId)),
          ConsistentRead: true,
        }),
      );
      if (!result.Item) {
        return [];
      }
      const record = toRecord(result.Item as Item);
      return matchesWhere(record, where) ? [record] : [];
    }
  }
  const items = uniqueClause
    ? await queryPartition(
        "GSI2",
        "GSI2PK",
        keys.authUniqueLookup(model, uniqueClause.field, String(uniqueClause.value)),
      )
    : await queryPartition("GSI1", "GSI1PK", keys.authModelPartition(model));

  return items.map(toRecord).filter((r) => matchesWhere(r, where));
}

function buildItem(model: string, data: Item): Item {
  const id = String(data.id);
  const item: Item = {
    ...data,
    ...keys.auth(model, id),
    GSI1PK: keys.authModelPartition(model),
    GSI1SK: id,
    entityType: `auth:${model}`,
  };
  const iso = data.expiresAt;
  if (typeof iso === "string") {
    const seconds = expiresAtFromIso(iso);
    if (seconds !== undefined) {
      item.expiresAt = seconds;
      item[EXPIRES_AT_ISO] = iso;
    }
  }
  const uniqueField = uniqueFieldFor(model, data);
  if (uniqueField) {
    item.GSI2PK = keys.authUniqueLookup(model, uniqueField, String(data[uniqueField]));
    item.GSI2SK = "ITEM";
  }
  return item;
}

async function createItem(model: string, data: Item): Promise<void> {
  const table = getTableName();
  const item = buildItem(model, data);
  const lock = uniqueLock(model, data);
  const transactItems = [
    {
      Put: {
        TableName: table,
        Item: item,
        ConditionExpression: "attribute_not_exists(PK)",
      },
    },
    ...(lock
      ? [
          {
            Put: {
              TableName: table,
              Item: lock,
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
        ]
      : []),
  ];
  await getDocumentClient().send(new TransactWriteCommand({ TransactItems: transactItems }));
}

async function replaceItem(model: string, existing: Item, next: Item): Promise<void> {
  const table = getTableName();
  const oldLock = uniqueLock(model, existing);
  const newLock = uniqueLock(model, next);
  const sameLock = oldLock?.PK === newLock?.PK;
  const transactItems = [
    {
      Put: {
        TableName: table,
        Item: buildItem(model, next),
        ConditionExpression: "attribute_exists(PK)",
      },
    },
    ...(newLock
      ? [
          {
            Put: {
              TableName: table,
              Item: newLock,
              ConditionExpression: "attribute_not_exists(PK) OR targetId = :targetId",
              ExpressionAttributeValues: { ":targetId": String(next.id) },
            },
          },
        ]
      : []),
    ...(!sameLock && oldLock
      ? [
          {
            Delete: {
              TableName: table,
              Key: { PK: oldLock.PK, SK: oldLock.SK },
              ConditionExpression: "attribute_not_exists(PK) OR targetId = :targetId",
              ExpressionAttributeValues: { ":targetId": String(existing.id) },
            },
          },
        ]
      : []),
  ];
  await getDocumentClient().send(new TransactWriteCommand({ TransactItems: transactItems }));
}

async function deleteItem(model: string, target: Item): Promise<void> {
  const table = getTableName();
  const lock = uniqueLock(model, target);
  await getDocumentClient().send(
    new TransactWriteCommand({
      TransactItems: [
        { Delete: { TableName: table, Key: keys.auth(model, String(target.id)) } },
        ...(lock
          ? [
              {
                Delete: {
                  TableName: table,
                  Key: { PK: lock.PK, SK: lock.SK },
                  ConditionExpression: "attribute_not_exists(PK) OR targetId = :targetId",
                  ExpressionAttributeValues: { ":targetId": String(target.id) },
                },
              },
            ]
          : []),
      ],
    }),
  );
}

export const dynamodbAdapter = createAdapter({
  config: {
    adapterId: "dynamodb",
    adapterName: "DynamoDB Single Table Adapter",
    usePlural: false,
    supportsJSON: true,
    supportsDates: false,
    supportsBooleans: true,
    supportsNumericIds: false,
  },
  adapter: () => ({
    async create({ model, data }) {
      await createItem(model, data as Item);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return data as any;
    },
    async findOne({ model, where }) {
      const records = await findRecords(model, where as Where[]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (records[0] ?? null) as any;
    },
    async findMany({ model, where, limit, sortBy, offset }) {
      let records = await findRecords(model, (where ?? []) as Where[]);
      if (sortBy) {
        const { field, direction } = sortBy;
        records = records.sort((a, b) => {
          const av = a[field] as never;
          const bv = b[field] as never;
          const cmp = av < bv ? -1 : av > bv ? 1 : 0;
          return direction === "desc" ? -cmp : cmp;
        });
      }
      if (offset) records = records.slice(offset);
      if (limit !== undefined) records = records.slice(0, limit);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return records as any;
    },
    async count({ model, where }) {
      const records = await findRecords(model, (where ?? []) as Where[]);
      return records.length;
    },
    async update({ model, where, update }) {
      const records = await findRecords(model, where as Where[]);
      const existing = records[0];
      if (!existing) return null;
      const merged = { ...existing, ...(update as Item) };
      await replaceItem(model, existing, merged);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return merged as any;
    },
    async updateMany({ model, where, update }) {
      const records = await findRecords(model, where as Where[]);
      for (const existing of records) {
        const merged = { ...existing, ...(update as Item) };
        await replaceItem(model, existing, merged);
      }
      return records.length;
    },
    async delete({ model, where }) {
      const records = await findRecords(model, where as Where[]);
      const target = records[0];
      if (!target) return;
      await deleteItem(model, target);
    },
    async deleteMany({ model, where }) {
      const records = await findRecords(model, where as Where[]);
      for (const target of records) {
        await deleteItem(model, target);
      }
      return records.length;
    },
  }),
});
