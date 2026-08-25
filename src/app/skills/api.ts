import type { Skill } from "@/domain/skill/types";
import type {
  CreateSkillInput,
  UpdateSkillInput,
} from "@/application/skill/skillUseCases";
import type { SkillSummary } from "@/app/api/skills/route";
import { assertOk, jsonHeaders, readJson } from "@/app/_lib/httpClient";

export type { Skill };

export type { SkillSummary };
export type { CreateSkillInput, UpdateSkillInput };

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
