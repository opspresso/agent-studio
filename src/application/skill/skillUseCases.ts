import type { SkillRepository } from "@/domain/skill/repository";
import type { Skill } from "@/domain/skill/types";
import {
  createRegistryUseCases,
  type RegistryUseCases,
} from "@/application/registry/registryUseCases";

export interface CreateSkillInput {
  name: string;
  description: string;
  content: string;
}

export interface UpdateSkillInput {
  description?: string;
  content?: string;
}

export type SkillUseCases = RegistryUseCases<Skill, CreateSkillInput, UpdateSkillInput>;

export function createSkillUseCases(repo: SkillRepository): SkillUseCases {
  return createRegistryUseCases<Skill, CreateSkillInput, UpdateSkillInput>({
    label: "Skill",
    repo,
    build(input, now) {
      return {
        name: input.name,
        description: input.description,
        content: input.content,
        createdAt: now,
        updatedAt: now,
      };
    },
    apply(existing, patch, now) {
      return {
        ...existing,
        description: patch.description ?? existing.description,
        content: patch.content ?? existing.content,
        updatedAt: now,
      };
    },
  });
}
