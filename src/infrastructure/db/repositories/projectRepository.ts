import {
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
  type BatchWriteCommandInput,
  type BatchWriteCommandOutput,
} from "@aws-sdk/lib-dynamodb";
import { getDocumentClient, getTableName } from "@/infrastructure/db/client";
import { queryAll } from "@/infrastructure/db/query";
import { keys } from "@/infrastructure/db/keys";
import type { ProjectRepository } from "@/domain/project/repository";
import type { Project, ProjectApiToken } from "@/domain/project/types";

const ENTITY_TYPE = "PROJECT";
const BATCH_SIZE = 25;

interface ProjectItem extends Project {
  PK: string;
  SK: string;
  GSI1PK: string;
  GSI1SK: string;
  entityType: typeof ENTITY_TYPE;
}

function toItem(project: Project): ProjectItem {
  const key = keys.project(project.name);
  return {
    ...project,
    PK: key.PK,
    SK: key.SK,
    GSI1PK: keys.typePartition("PROJECT"),
    GSI1SK: project.name,
    entityType: ENTITY_TYPE,
  };
}

function fromItem(item: Record<string, unknown>): Project {
  return {
    name: item.name as string,
    displayName: item.displayName as string,
    description: item.description as string,
    projectType: item.projectType as Project["projectType"],
    ownerEmail: item.ownerEmail as string,
    departmentCode: item.departmentCode as string | undefined,
    publishedVersion: item.publishedVersion as string | undefined,
    slack: item.slack as Project["slack"] | undefined,
    createdAt: item.createdAt as string,
    updatedAt: item.updatedAt as string,
  };
}

/** Batch-delete the given PK/SK pairs, retrying unprocessed items. */
async function batchDelete(deleteKeys: { PK: string; SK: string }[]): Promise<void> {
  const client = getDocumentClient();
  const table = getTableName();
  for (let i = 0; i < deleteKeys.length; i += BATCH_SIZE) {
    const chunk = deleteKeys.slice(i, i + BATCH_SIZE);
    let request: BatchWriteCommandInput["RequestItems"] = {
      [table]: chunk.map((Key) => ({ DeleteRequest: { Key } })),
    };
    // Retry any unprocessed items until the batch drains.
    for (let attempt = 0; attempt < 5 && request && Object.keys(request).length > 0; attempt++) {
      const result: BatchWriteCommandOutput = await client.send(
        new BatchWriteCommand({ RequestItems: request }),
      );
      request = result.UnprocessedItems;
    }
    if (request && Object.values(request).some((items) => (items?.length ?? 0) > 0)) {
      throw new Error(`Failed to delete all DynamoDB items after 5 attempts (${chunk.length} requested)`);
    }
  }
}

const toDeleteKey = (item: Record<string, unknown>) => ({
  PK: item.PK as string,
  SK: item.SK as string,
});

/** Collect all PK/SK pairs under a partition, then batch-delete them. */
async function deletePartition(pk: string): Promise<void> {
  const items = await queryAll({
    TableName: getTableName(),
    KeyConditionExpression: "PK = :pk",
    ExpressionAttributeValues: { ":pk": pk },
    ProjectionExpression: "PK, SK",
    ConsistentRead: true,
  });
  await batchDelete(items.map(toDeleteKey));
}

/** Delete every trace row for a project (traces live in their own partitions,
 * found via the GSI1 project index). */
async function deleteTracesForProject(projectName: string): Promise<void> {
  const items = await queryAll({
    TableName: getTableName(),
    IndexName: "GSI1",
    KeyConditionExpression: "GSI1PK = :pk",
    ExpressionAttributeValues: { ":pk": keys.traceProjectPartition(projectName) },
    ProjectionExpression: "PK, SK",
  });
  await batchDelete(items.map(toDeleteKey));
}

export const projectRepository: ProjectRepository = {
  async get(name: string): Promise<Project | null> {
    const result = await getDocumentClient().send(
      new GetCommand({ TableName: getTableName(), Key: keys.project(name) }),
    );
    return result.Item ? fromItem(result.Item) : null;
  },

  async list(): Promise<Project[]> {
    const items = await queryAll({
      TableName: getTableName(),
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: { ":pk": keys.typePartition("PROJECT") },
    });
    return items.map(fromItem);
  },

  async create(project: Project): Promise<void> {
    await getDocumentClient().send(
      new PutCommand({
        TableName: getTableName(),
        Item: toItem(project),
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
  },

  async update(project: Project, expectedUpdatedAt: string): Promise<void> {
    await getDocumentClient().send(
      new PutCommand({
        TableName: getTableName(),
        Item: toItem(project),
        ConditionExpression:
          "attribute_exists(PK) AND attribute_not_exists(deletingAt) AND updatedAt = :expectedUpdatedAt",
        ExpressionAttributeValues: { ":expectedUpdatedAt": expectedUpdatedAt },
      }),
    );
  },

  async publish(
    project: Project,
    versionName: string,
    expectedUpdatedAt: string,
  ): Promise<void> {
    await getDocumentClient().send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: getTableName(),
              Key: keys.version(project.name, versionName),
              ConditionExpression: "attribute_exists(PK)",
            },
          },
          {
            Put: {
              TableName: getTableName(),
              Item: toItem(project),
              ConditionExpression:
                "attribute_exists(PK) AND attribute_not_exists(deletingAt) AND updatedAt = :expectedUpdatedAt",
              ExpressionAttributeValues: { ":expectedUpdatedAt": expectedUpdatedAt },
            },
          },
        ],
      }),
    );
  },

  /**
   * Cascade delete: project META, all its versions (same partition), all usage
   * rows, and all trace rows. Chats are owned by users, not the project, so they
   * are intentionally left intact.
   */
  async delete(name: string): Promise<void> {
    await getDocumentClient().send(
      new UpdateCommand({
        TableName: getTableName(),
        Key: keys.project(name),
        UpdateExpression: "SET deletingAt = if_not_exists(deletingAt, :now)",
        ConditionExpression: "attribute_exists(PK)",
        ExpressionAttributeValues: { ":now": new Date().toISOString() },
      }),
    );
    await deletePartition(keys.usage(name, "").PK);
    await deleteTracesForProject(name);
    const projectItems = await queryAll({
      TableName: getTableName(),
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": keys.projectPartition(name) },
      ProjectionExpression: "PK, SK, tracePK, traceSK",
      ConsistentRead: true,
    });
    const traceTargets = projectItems.flatMap((item) =>
      typeof item.tracePK === "string" && typeof item.traceSK === "string"
        ? [{ PK: item.tracePK, SK: item.traceSK }]
        : [],
    );
    await batchDelete(
      [
        ...projectItems
          .filter((item) => item.SK !== "META")
          .map(toDeleteKey),
        ...traceTargets,
      ],
    );
    await getDocumentClient().send(
      new DeleteCommand({
        TableName: getTableName(),
        Key: keys.project(name),
        ConditionExpression: "attribute_exists(PK) AND attribute_exists(deletingAt)",
      }),
    );
  },

  async getApiToken(name: string): Promise<ProjectApiToken | null> {
    const result = await getDocumentClient().send(
      new GetCommand({ TableName: getTableName(), Key: keys.projectApiToken(name) }),
    );
    if (!result.Item) {
      return null;
    }
    // One of `token` (encrypted, revealable) or `tokenHash` (legacy) is set.
    return {
      ...(typeof result.Item.token === "string" ? { token: result.Item.token } : {}),
      ...(typeof result.Item.tokenHash === "string" ? { tokenHash: result.Item.tokenHash } : {}),
      masked: result.Item.masked as string | undefined,
      createdAt: result.Item.createdAt as string,
    };
  },

  async setApiToken(name: string, token: ProjectApiToken): Promise<void> {
    const key = keys.projectApiToken(name);
    await getDocumentClient().send(
      new PutCommand({
        TableName: getTableName(),
        Item: {
          ...key,
          entityType: "APITOKEN",
          // Written as one whole item, so regenerating an encrypted token over a
          // legacy hashed one leaves no stale `tokenHash` behind.
          ...(token.token !== undefined ? { token: token.token } : {}),
          ...(token.tokenHash !== undefined ? { tokenHash: token.tokenHash } : {}),
          masked: token.masked,
          createdAt: token.createdAt,
        },
      }),
    );
  },

  async deleteApiToken(name: string): Promise<void> {
    await getDocumentClient().send(
      new DeleteCommand({ TableName: getTableName(), Key: keys.projectApiToken(name) }),
    );
  },
};
