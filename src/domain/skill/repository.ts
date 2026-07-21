import type { Skill } from "./types";

export interface SkillRepository {
  get(name: string): Promise<Skill | null>;
  list(): Promise<Skill[]>;
  put(skill: Skill): Promise<void>;
  delete(name: string): Promise<void>;
}
