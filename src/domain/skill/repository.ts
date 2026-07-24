import type { Skill } from "./types";

export interface SkillRepository {
  get(name: string): Promise<Skill | null>;
  list(): Promise<Skill[]>;
  create(skill: Skill): Promise<void>;
  update(skill: Skill): Promise<void>;
  put(skill: Skill): Promise<void>;
  delete(name: string): Promise<void>;
}
