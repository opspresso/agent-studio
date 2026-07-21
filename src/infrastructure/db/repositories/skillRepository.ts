import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { SkillRepository } from "@/domain/skill/repository";
import type { Skill } from "@/domain/skill/types";
import { getDocumentClient, getTableName } from "../client";
import { keys } from "../keys";

const ENTITY_TYPE = "SKILL" as const;

function fromItem(item: Record<string, unknown>): Skill {
  return {
    name: item.name as string,
    description: item.description as string,
    content: item.content as string,
    createdAt: item.createdAt as string,
    updatedAt: item.updatedAt as string,
  };
}

function toItem(skill: Skill): Record<string, unknown> {
  return {
    ...keys.skill(skill.name),
    GSI1PK: keys.typePartition(ENTITY_TYPE),
    GSI1SK: skill.name,
    entityType: ENTITY_TYPE,
    name: skill.name,
    description: skill.description,
    content: skill.content,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
  };
}

export const skillRepository: SkillRepository = {
  async get(name) {
    const res = await getDocumentClient().send(
      new GetCommand({ TableName: getTableName(), Key: keys.skill(name) }),
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

  async put(skill) {
    await getDocumentClient().send(
      new PutCommand({ TableName: getTableName(), Item: toItem(skill) }),
    );
  },

  async delete(name) {
    await getDocumentClient().send(
      new DeleteCommand({ TableName: getTableName(), Key: keys.skill(name) }),
    );
  },
};
