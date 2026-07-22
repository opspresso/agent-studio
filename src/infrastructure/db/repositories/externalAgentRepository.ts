import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { ExternalAgentRepository } from "@/domain/agent/repository";
import type { AgentProtocol, ExternalAgent } from "@/domain/agent/types";
import { getDocumentClient, getTableName } from "../client";
import { queryAll } from "../query";
import { keys } from "../keys";

const ENTITY_TYPE = "AGENT" as const;

function fromItem(item: Record<string, unknown>): ExternalAgent {
  return {
    name: item.name as string,
    url: item.url as string,
    protocol: (item.protocol as AgentProtocol | undefined) ?? undefined,
    description: item.description as string,
    headers: (item.headers as Record<string, string> | undefined) ?? {},
    createdAt: item.createdAt as string,
    updatedAt: item.updatedAt as string,
  };
}

function toItem(agent: ExternalAgent): Record<string, unknown> {
  return {
    ...keys.externalAgent(agent.name),
    GSI1PK: keys.typePartition(ENTITY_TYPE),
    GSI1SK: agent.name,
    entityType: ENTITY_TYPE,
    name: agent.name,
    url: agent.url,
    ...(agent.protocol ? { protocol: agent.protocol } : {}),
    description: agent.description,
    headers: agent.headers,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}

export const externalAgentRepository: ExternalAgentRepository = {
  async get(name) {
    const res = await getDocumentClient().send(
      new GetCommand({ TableName: getTableName(), Key: keys.externalAgent(name) }),
    );
    return res.Item ? fromItem(res.Item) : null;
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

  async put(agent) {
    await getDocumentClient().send(
      new PutCommand({ TableName: getTableName(), Item: toItem(agent) }),
    );
  },

  async delete(name) {
    await getDocumentClient().send(
      new DeleteCommand({ TableName: getTableName(), Key: keys.externalAgent(name) }),
    );
  },
};
