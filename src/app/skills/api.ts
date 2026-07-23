import type { Skill } from "@/domain/skill/types";
import { assertOk, jsonHeaders, readJson } from "@/app/_lib/httpClient";

export type { Skill };

export interface CreateSkillInput {
  name: string;
  description: string;
  content: string;
}

export interface UpdateSkillInput {
  description?: string;
  content?: string;
}

export function listSkills(): Promise<Skill[]> {
  return fetch("/api/skills").then((r) => readJson<Skill[]>(r));
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
