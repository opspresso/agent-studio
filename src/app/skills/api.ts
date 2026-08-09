import type { Skill } from "@/domain/skill/types";
import { assertOk, jsonHeaders, readJson } from "@/app/_lib/httpClient";

export type { Skill };

/** What the list endpoint ships — the card's fields, never the body. */
export interface SkillSummary {
  name: string;
  description: string;
  source?: string;
  /** Attachment count; the files themselves come with the detail read. */
  files: number;
  updatedAt: string;
}

export interface CreateSkillInput {
  name: string;
  description: string;
  content: string;
}

export interface UpdateSkillInput {
  description?: string;
  content?: string;
}

export function listSkills(): Promise<SkillSummary[]> {
  return fetch("/api/skills").then((r) => readJson<SkillSummary[]>(r));
}

export function getSkill(name: string): Promise<Skill> {
  return fetch(`/api/skills/${name}`).then((r) => readJson<Skill>(r));
}

export function createSkill(input: CreateSkillInput): Promise<Skill> {
  return fetch("/api/skills", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  }).then((r) => readJson<Skill>(r));
}

export function updateSkill(name: string, patch: UpdateSkillInput): Promise<Skill> {
  return fetch(`/api/skills/${name}`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify(patch),
  }).then((r) => readJson<Skill>(r));
}

export async function deleteSkill(name: string): Promise<void> {
  await assertOk(await fetch(`/api/skills/${name}`, { method: "DELETE" }));
}
