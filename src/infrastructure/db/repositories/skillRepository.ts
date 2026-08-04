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

export const skillRepository: SkillRepository = {
  ...createKeyedRepository<Skill>({
    entityType: ENTITY_TYPE,
    key: keys.skill,
    toItem,
    fromItem,
  }),

  /**
   * One read per name, projected down to the one attribute a prompt's skill
   * table needs. Still one round trip — the reads are concurrent — but a skill
   * with attachments no longer crosses the wire in full so that a run can print
   * its one-line description.
   *
   * The name comes back from the key that was asked for, not from the item's own
   * `name` attribute. The caller looks the answer up by the name its version
   * bound, so echoing a stored one makes a row whose attribute has drifted from
   * its key — a hand repair, a partial write — report as *deleted* to the prompt
   * while `get` on the same name still returns the skill. It also keeps `name`
   * out of the projection, and with it the `ExpressionAttributeNames` alias that
   * DynamoDB's reserved-word list would otherwise force.
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
            ProjectionExpression: "description",
          }),
        );
        return res.Item ? { name, description: (res.Item.description as string) ?? "" } : null;
      }),
    );
    return found.filter((entry): entry is SkillDescription => entry !== null);
  },
};
