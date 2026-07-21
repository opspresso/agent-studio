import { describe, expect, it } from "vitest";
import { parseSkillDoc, syncSkillsFromSnapshot } from "@/application/skill/syncSkills";
import type { Skill } from "@/domain/skill/types";
import type { SkillRepository } from "@/domain/skill/repository";

function fakeRepo(initial: Skill[] = []) {
  const store = new Map(initial.map((s) => [s.name, s]));
  const repo: SkillRepository = {
    async get(name) {
      return store.get(name) ?? null;
    },
    async list() {
      return [...store.values()];
    },
    async put(skill) {
      store.set(skill.name, skill);
    },
    async delete(name) {
      store.delete(name);
    },
  };
  return { repo, store };
}

describe("parseSkillDoc", () => {
  it("extracts description from frontmatter and strips it from the body", () => {
    const doc = "---\nname: greeting\ndescription: Say hello nicely\n---\n# Greeting\nBe warm.";
    expect(parseSkillDoc(doc)).toEqual({
      description: "Say hello nicely",
      body: "# Greeting\nBe warm.",
    });
  });

  it("falls back to the first heading without frontmatter", () => {
    const doc = "# Review checklist\nAlways check tests.";
    const parsed = parseSkillDoc(doc);
    expect(parsed.description).toBe("Review checklist");
    expect(parsed.body).toBe(doc);
  });

  it("handles quoted frontmatter values", () => {
    const doc = '---\ndescription: "Quoted value"\n---\nBody';
    expect(parseSkillDoc(doc).description).toBe("Quoted value");
  });
});

describe("syncSkillsFromSnapshot", () => {
  const snapshot = {
    repo: "opspresso/agent-skills",
    branch: "main",
    commitSha: "abc123",
    files: [
      {
        name: "greeting",
        path: "skills/greeting/SKILL.md",
        content: "---\ndescription: Say hello\n---\nBe warm.",
      },
    ],
  };

  it("upserts new skills with a source marker", async () => {
    const { repo, store } = fakeRepo();
    const result = await syncSkillsFromSnapshot(repo, snapshot);
    expect(result.synced).toEqual(["greeting"]);
    expect(store.get("greeting")).toMatchObject({
      description: "Say hello",
      content: "Be warm.",
      source: "github:opspresso/agent-skills",
    });
  });

  it("keeps createdAt on resync and reports unchanged content", async () => {
    const { repo, store } = fakeRepo([
      {
        name: "greeting",
        description: "Say hello",
        content: "Be warm.",
        source: "github:opspresso/agent-skills",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ]);
    const result = await syncSkillsFromSnapshot(repo, snapshot);
    expect(result.synced).toEqual([]);
    expect(result.unchanged).toBe(1);
    expect(store.get("greeting")?.createdAt).toBe("2026-01-01T00:00:00Z");
  });

  it("does not touch locally-created skills with other names", async () => {
    const local: Skill = {
      name: "local-only",
      description: "Local",
      content: "Stays",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const { repo, store } = fakeRepo([local]);
    await syncSkillsFromSnapshot(repo, snapshot);
    expect(store.get("local-only")).toEqual(local);
  });
});
