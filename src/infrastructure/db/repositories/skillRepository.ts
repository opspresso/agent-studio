import type { SkillDescription, SkillRepository } from "@/domain/skill/repository";
import type { Skill, SkillFile } from "@/domain/skill/types";
import { createKeyedRepository } from "../keyedRepository";
import { sql } from "../client";
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
   * One statement for every name, projected down to the one attribute a
   * prompt's skill table needs: a skill with attachments does not cross the
   * wire in full so that a run can print its one-line description.
   *
   * The name comes back from the key that was asked for, not from the item's
   * own `name` attribute. The caller looks the answer up by the name its
   * Agent bound, so echoing a stored one makes a row whose attribute has
   * drifted from its key — a hand repair, a partial write — report as
   * *deleted* to the prompt while `get` on the same name still returns the
   * skill.
   *
   * A name with no item is left out, and the caller reports it: to a run, a
   * skill that has left the registry and one that never existed are the same
   * missing binding.
   */
  async describe(names: readonly string[]): Promise<SkillDescription[]> {
    if (names.length === 0) {
      return [];
    }
    const rows = await sql<{ pk: string; description: string | null }>(
      "SELECT pk, data->>'description' AS description FROM items WHERE sk = $1 AND pk = ANY($2::text[])",
      [keys.skill("").SK, names.map((name) => keys.skill(name).PK)],
    );
    const byPk = new Map(rows.map((row) => [row.pk, row.description ?? ""]));
    return names.flatMap((name): SkillDescription[] => {
      const description = byPk.get(keys.skill(name).PK);
      return description === undefined ? [] : [{ name, description }];
    });
  },
};
