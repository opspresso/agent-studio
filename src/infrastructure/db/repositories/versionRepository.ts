import {
  DeleteCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { getDocumentClient, getTableName } from "@/infrastructure/db/client";
import { keys } from "@/infrastructure/db/keys";
import type { VersionRepository } from "@/domain/project/repository";
import type { Version } from "@/domain/project/types";

const ENTITY_TYPE = "VERSION";
const PUBLISHED = "published";

interface VersionItem extends Version {
  PK: string;
  SK: string;
  entityType: typeof ENTITY_TYPE;
}

function toItem(version: Version): VersionItem {
  const key = keys.version(version.projectName, version.versionName);
  return {
    ...version,
    PK: key.PK,
    SK: key.SK,
    entityType: ENTITY_TYPE,
  };
}

function fromItem(item: Record<string, unknown>): Version {
  return {
    projectName: item.projectName as string,
    versionName: item.versionName as string,
    systemPrompt: item.systemPrompt as string,
    userPromptTemplate: item.userPromptTemplate as string,
    model: item.model as string,
    fallbackModel: item.fallbackModel as string | undefined,
    parameters: item.parameters as Version["parameters"],
    mcpList: (item.mcpList as string[] | undefined) ?? [],
    skillList: (item.skillList as string[] | undefined) ?? [],
    subagentList: (item.subagentList as Version["subagentList"] | undefined) ?? [],
    maxTurn: item.maxTurn as number | undefined,
    createdAt: item.createdAt as string,
  };
}

/** Resolve the concrete version name a project's "published" pointer refers to. */
async function resolvePublished(projectName: string): Promise<string | null> {
  const result = await getDocumentClient().send(
    new GetCommand({
      TableName: getTableName(),
      Key: keys.project(projectName),
      ProjectionExpression: "publishedVersion",
    }),
  );
  const pointer = result.Item?.publishedVersion as string | undefined;
  return pointer ?? null;
}

export const versionRepository: VersionRepository = {
  async get(projectName: string, versionName: string): Promise<Version | null> {
    let resolved = versionName;
    if (versionName === PUBLISHED) {
      const pointer = await resolvePublished(projectName);
      if (!pointer) {
        return null;
      }
      resolved = pointer;
    }

    const result = await getDocumentClient().send(
      new GetCommand({ TableName: getTableName(), Key: keys.version(projectName, resolved) }),
    );
    return result.Item ? fromItem(result.Item) : null;
  },

  async list(projectName: string): Promise<Version[]> {
    const client = getDocumentClient();
    const table = getTableName();
    const versions: Version[] = [];

    let lastKey: Record<string, unknown> | undefined;
    do {
      const page = await client.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
          ExpressionAttributeValues: {
            ":pk": keys.projectPartition(projectName),
            ":prefix": keys.versionPrefix(),
          },
          ExclusiveStartKey: lastKey,
        }),
      );
      for (const item of page.Items ?? []) {
        versions.push(fromItem(item));
      }
      lastKey = page.LastEvaluatedKey;
    } while (lastKey);

    return versions;
  },

  async put(version: Version): Promise<void> {
    await getDocumentClient().send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: getTableName(),
              Key: keys.project(version.projectName),
              ConditionExpression: "attribute_exists(PK) AND attribute_not_exists(deletingAt)",
            },
          },
          {
            Put: {
              TableName: getTableName(),
              Item: toItem(version),
              ConditionExpression: "attribute_exists(PK)",
            },
          },
        ],
      }),
    );
  },

  async create(version: Version): Promise<void> {
    await getDocumentClient().send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: getTableName(),
              Key: keys.project(version.projectName),
              ConditionExpression: "attribute_exists(PK) AND attribute_not_exists(deletingAt)",
            },
          },
          {
            Put: {
              TableName: getTableName(),
              Item: toItem(version),
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
        ],
      }),
    );
  },

  async delete(projectName: string, versionName: string): Promise<void> {
    await getDocumentClient().send(
      new DeleteCommand({
        TableName: getTableName(),
        Key: keys.version(projectName, versionName),
      }),
    );
  },
};
