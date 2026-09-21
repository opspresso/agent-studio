import type { Skill } from "./types";

/** A skill as the prompt's skill table needs it: a name and one line about it. */
export interface SkillDescription {
  name: string;
  description: string;
}

export interface SkillRepository {
  get(name: string): Promise<Skill | null>;
  /**
   * The bound skills' descriptions, without their bodies.
   *
   * Progressive disclosure is what the `Skill` tool is for — the model reads a
   * one-line description and asks for the body only when it wants it. This read
   * must not fetch whole skill bodies or attachments merely to render that line.
   *
   * Each entry's `name` is the one that was **asked for**, so a caller can look
   * its answer up by the name its Agent bound. Names absent from the answer
   * are absent from the registry; the run reports each one and does not offer
   * it.
   */
  describe(names: readonly string[]): Promise<SkillDescription[]>;
  list(limit: number, after?: string): Promise<Skill[]>;
  create(skill: Skill): Promise<void>;
  update(skill: Skill): Promise<void>;
  put(skill: Skill): Promise<void>;
  delete(name: string): Promise<void>;
}
