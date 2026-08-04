import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { SkillDescription, SkillRepository } from "@/domain/skill/repository";
import type { Skill, SkillFile } from "@/domain/skill/types";
import { createKeyedRepository } from "../keyedRepository";
import { getDocumentClient, getTableName } from "../client";
import { keys } from "../keys";

const ENTITY_TYPE = "SKILL" as const;

function fromItem(item: Record<string, unknown>): Skill {
  return {
    name: item.name as string,
    description: item.description as string,
    content: item.content as string,
    files: item.files as SkillFile[] | undefined,
    source: item.source as string | undefined,
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
    files: skill.files,
    source: skill.source,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
  };
}

/**
 * `name` is a reserved word in DynamoDB's expression grammar and can only be
 * projected through an alias; `description` is not, and is named directly. The
 * service is the only thing that can tell you which — the integration check
 * covers this projection for that reason.
 */
const DESCRIPTION_PROJECTION = {
  ProjectionExpression: "#name, description",
  ExpressionAttributeNames: { "#name": "name" },
} as const;

export const skillRepository: SkillRepository = {
  ...createKeyedRepository<Skill>({
    entityType: ENTITY_TYPE,
    key: keys.skill,
    toItem,
    fromItem,
  }),

  /**
   * One read per name, projected down to the two attributes a prompt's skill
   * table shows. Still one round trip — the reads are concurrent — but a skill
   * with attachments no longer crosses the wire in full so that a run can print
   * its one-line description.
   *
   * Deliberately not `BatchGetItem`: it caps at 100 keys and can return
   * `UnprocessedKeys`, so the batched form would need chunking and a retry loop
   * to answer the same question. The RCUs are identical either way — DynamoDB
   * bills a projected read on the whole item — so the batch buys nothing here.
   *
   * A name with no item is left out, and the caller reports it: to a run, a
   * skill that has left the registry and one that never existed are the same
   * missing binding.
   */
  async describe(names: readonly string[]): Promise<SkillDescription[]> {
    const found = await Promise.all(
      names.map(async (name) => {
        const res = await getDocumentClient().send(
          new GetCommand({
            TableName: getTableName(),
            Key: keys.skill(name),
            ...DESCRIPTION_PROJECTION,
          }),
        );
        return res.Item
          ? { name: res.Item.name as string, description: (res.Item.description as string) ?? "" }
          : null;
      }),
    );
    return found.filter((entry): entry is SkillDescription => entry !== null);
  },
};
