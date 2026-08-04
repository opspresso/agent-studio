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
   * one-line description and asks for the body only when it wants it — but a run
   * used to fetch every bound skill *whole*, attachments included, to render
   * that one line. A run whose model never calls the tool paid for all of it
   * before its first token.
   *
   * Names the caller asked for that are absent from the answer are absent from
   * the registry; the run reports each one and does not offer it.
   */
  describe(names: readonly string[]): Promise<SkillDescription[]>;
  list(): Promise<Skill[]>;
  create(skill: Skill): Promise<void>;
  update(skill: Skill): Promise<void>;
  put(skill: Skill): Promise<void>;
  delete(name: string): Promise<void>;
}
