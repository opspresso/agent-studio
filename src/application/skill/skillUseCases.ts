import type { SkillRepository } from "@/domain/skill/repository";
import type { Skill } from "@/domain/skill/types";

export interface CreateSkillInput {
  name: string;
  description: string;
  content: string;
}

export interface UpdateSkillInput {
  description?: string;
  content?: string;
}

export interface SkillUseCases {
  list(): Promise<Skill[]>;
  get(name: string): Promise<Skill | null>;
  /** Returns the created skill, or `null` when a skill with the same name already exists. */
  create(input: CreateSkillInput): Promise<Skill | null>;
  /** Returns the updated skill, or `null` when no skill with that name exists. */
  update(name: string, patch: UpdateSkillInput): Promise<Skill | null>;
  /** Returns `true` when a skill was deleted, `false` when none existed. */
  remove(name: string): Promise<boolean>;
}

export function createSkillUseCases(repo: SkillRepository): SkillUseCases {
  return {
    list: () => repo.list(),
    get: (name) => repo.get(name),

    async create(input) {
      const existing = await repo.get(input.name);
      if (existing) {
        return null;
      }
      const now = new Date().toISOString();
      const skill: Skill = {
        name: input.name,
        description: input.description,
        content: input.content,
        createdAt: now,
        updatedAt: now,
      };
      await repo.put(skill);
      return skill;
    },

    async update(name, patch) {
      const existing = await repo.get(name);
      if (!existing) {
        return null;
      }
      const updated: Skill = {
        ...existing,
        description: patch.description ?? existing.description,
        content: patch.content ?? existing.content,
        updatedAt: new Date().toISOString(),
      };
      await repo.put(updated);
      return updated;
    },

    async remove(name) {
      const existing = await repo.get(name);
      if (!existing) {
        return false;
      }
      await repo.delete(name);
      return true;
    },
  };
}
