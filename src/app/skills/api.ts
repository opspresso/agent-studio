export interface Skill {
  name: string;
  description: string;
  content: string;
  createdAt: string;
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

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
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
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).then((r) => readJson<Skill>(r));
}

export function updateSkill(name: string, patch: UpdateSkillInput): Promise<Skill> {
  return fetch(`/api/skills/${name}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  }).then((r) => readJson<Skill>(r));
}

export async function deleteSkill(name: string): Promise<void> {
  const res = await fetch(`/api/skills/${name}`, { method: "DELETE" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
}
