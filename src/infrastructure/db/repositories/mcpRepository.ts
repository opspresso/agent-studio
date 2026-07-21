import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { McpRepository } from "@/domain/mcp/repository";
import type { McpServer } from "@/domain/mcp/types";
import { getDocumentClient, getTableName } from "../client";
import { keys } from "../keys";

const ENTITY_TYPE = "MCP" as const;

function fromItem(item: Record<string, unknown>): McpServer {
  return {
    name: item.name as string,
    url: item.url as string,
    description: item.description as string | undefined,
    headers: (item.headers as Record<string, string> | undefined) ?? {},
    createdAt: item.createdAt as string,
    updatedAt: item.updatedAt as string,
  };
}

function toItem(server: McpServer): Record<string, unknown> {
  return {
    ...keys.mcp(server.name),
    GSI1PK: keys.typePartition(ENTITY_TYPE),
    GSI1SK: server.name,
    entityType: ENTITY_TYPE,
    name: server.name,
    url: server.url,
    description: server.description,
    headers: server.headers,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
  };
}

export const mcpRepository: McpRepository = {
  async get(name) {
    const res = await getDocumentClient().send(
      new GetCommand({ TableName: getTableName(), Key: keys.mcp(name) }),
    );
    return res.Item ? fromItem(res.Item) : null;
  },

  async list() {
    const res = await getDocumentClient().send(
      new QueryCommand({
        TableName: getTableName(),
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": keys.typePartition(ENTITY_TYPE) },
      }),
    );
    return (res.Items ?? []).map(fromItem);
  },

  async put(server) {
    await getDocumentClient().send(
      new PutCommand({ TableName: getTableName(), Item: toItem(server) }),
    );
  },

  async delete(name) {
    await getDocumentClient().send(
      new DeleteCommand({ TableName: getTableName(), Key: keys.mcp(name) }),
    );
  },
};
