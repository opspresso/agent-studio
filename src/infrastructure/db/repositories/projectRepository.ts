import {
  BatchWriteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  type BatchWriteCommandInput,
  type BatchWriteCommandOutput,
} from "@aws-sdk/lib-dynamodb";
import { getDocumentClient, getTableName } from "@/infrastructure/db/client";
import { keys } from "@/infrastructure/db/keys";
import type { ProjectRepository } from "@/domain/project/repository";
import type { Project } from "@/domain/project/types";

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
    createdAt: item.createdAt as string,
    updatedAt: item.updatedAt as string,
  };
}

/** Collect all PK/SK pairs under a partition, then batch-delete them. */
async function deletePartition(pk: string): Promise<void> {
  const client = getDocumentClient();
  const table = getTableName();
  const deleteKeys: { PK: string; SK: string }[] = [];

  let lastKey: Record<string, unknown> | undefined;
  do {
    const page = await client.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": pk },
        ProjectionExpression: "PK, SK",
        ExclusiveStartKey: lastKey,
      }),
    );
    for (const item of page.Items ?? []) {
      deleteKeys.push({ PK: item.PK as string, SK: item.SK as string });
    }
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);

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
  }
}

export const projectRepository: ProjectRepository = {
  async get(name: string): Promise<Project | null> {
    const result = await getDocumentClient().send(
      new GetCommand({ TableName: getTableName(), Key: keys.project(name) }),
    );
    return result.Item ? fromItem(result.Item) : null;
  },

  async list(): Promise<Project[]> {
    const client = getDocumentClient();
    const table = getTableName();
    const projects: Project[] = [];

    let lastKey: Record<string, unknown> | undefined;
    do {
      const page = await client.send(
        new QueryCommand({
          TableName: table,
          IndexName: "GSI1",
          KeyConditionExpression: "GSI1PK = :pk",
          ExpressionAttributeValues: { ":pk": keys.typePartition("PROJECT") },
          ExclusiveStartKey: lastKey,
        }),
      );
      for (const item of page.Items ?? []) {
        projects.push(fromItem(item));
      }
      lastKey = page.LastEvaluatedKey;
    } while (lastKey);

    return projects;
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

  async update(project: Project): Promise<void> {
    await getDocumentClient().send(
      new PutCommand({ TableName: getTableName(), Item: toItem(project) }),
    );
  },

  /** Cascade delete: project META, all its versions (same partition), and all usage rows. */
  async delete(name: string): Promise<void> {
    await deletePartition(keys.projectPartition(name));
    await deletePartition(keys.usage(name, "").PK);
  },
};
