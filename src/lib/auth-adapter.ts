import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { createAdapter } from "better-auth/adapters";
import { getDocumentClient, getTableName } from "@/infrastructure/db/client";
import { keys } from "@/infrastructure/db/keys";

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

function toRecord(item: Item): Item {
  const { PK, SK, GSI1PK, GSI1SK, GSI2PK, GSI2SK, entityType, ...rest } = item;
  void PK, SK, GSI1PK, GSI1SK, GSI2PK, GSI2SK, entityType;
  return rest;
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
  const uniqueField = (UNIQUE_FIELDS[model] ?? []).find((f) => data[f] !== undefined);
  if (uniqueField) {
    item.GSI2PK = keys.authUniqueLookup(model, uniqueField, String(data[uniqueField]));
    item.GSI2SK = "ITEM";
  }
  return item;
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
      await getDocumentClient().send(
        new PutCommand({ TableName: getTableName(), Item: buildItem(model, data as Item) }),
      );
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
      await getDocumentClient().send(
        new PutCommand({ TableName: getTableName(), Item: buildItem(model, merged) }),
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return merged as any;
    },
    async updateMany({ model, where, update }) {
      const records = await findRecords(model, where as Where[]);
      for (const existing of records) {
        const merged = { ...existing, ...(update as Item) };
        await getDocumentClient().send(
          new PutCommand({ TableName: getTableName(), Item: buildItem(model, merged) }),
        );
      }
      return records.length;
    },
    async delete({ model, where }) {
      const records = await findRecords(model, where as Where[]);
      const target = records[0];
      if (!target) return;
      await getDocumentClient().send(
        new DeleteCommand({ TableName: getTableName(), Key: keys.auth(model, String(target.id)) }),
      );
    },
    async deleteMany({ model, where }) {
      const records = await findRecords(model, where as Where[]);
      for (const target of records) {
        await getDocumentClient().send(
          new DeleteCommand({ TableName: getTableName(), Key: keys.auth(model, String(target.id)) }),
        );
      }
      return records.length;
    },
  }),
});
