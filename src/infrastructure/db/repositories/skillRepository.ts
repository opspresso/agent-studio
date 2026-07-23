import type { SkillRepository } from "@/domain/skill/repository";
import type { Skill } from "@/domain/skill/types";
import { createKeyedRepository } from "../keyedRepository";
import { keys } from "../keys";

const ENTITY_TYPE = "SKILL" as const;

function fromItem(item: Record<string, unknown>): Skill {
  return {
    name: item.name as string,
    description: item.description as string,
    content: item.content as string,
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
    source: skill.source,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
  };
}

export const skillRepository: SkillRepository = createKeyedRepository<Skill>({
  entityType: ENTITY_TYPE,
  key: keys.skill,
  toItem,
  fromItem,
});
