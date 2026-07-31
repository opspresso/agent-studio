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
    async create(skill) {
      store.set(skill.name, skill);
    },
    async update(skill) {
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
    skipped: [],
    files: [
      {
        name: "greeting",
        path: "skills/greeting/SKILL.md",
        content: "---\ndescription: Say hello\n---\nBe warm.",
        files: [],
      },
    ],
  };

  it("imports a skill the registry does not have, with a source marker", async () => {
    const { repo, store } = fakeRepo();
    const result = await syncSkillsFromSnapshot(repo, snapshot);
    expect(result.created).toEqual(["greeting"]);
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
    const result = await syncSkillsFromSnapshot(repo, snapshot, { overwrite: ["greeting"] });
    expect(result.existing).toEqual([{ name: "greeting", differs: [] }]);
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

  const withFiles = (files: { path: string; content: string }[]) => ({
    ...snapshot,
    files: [{ ...snapshot.files[0]!, files }],
  });

  it("stores attachment files on sync", async () => {
    const { repo, store } = fakeRepo();
    await syncSkillsFromSnapshot(repo, withFiles([{ path: "references/api.md", content: "# API" }]));
    expect(store.get("greeting")?.files).toEqual([{ path: "references/api.md", content: "# API" }]);
  });

  it("reports unchanged when attachment files are identical", async () => {
    const { repo } = fakeRepo();
    const snap = withFiles([{ path: "references/api.md", content: "# API" }]);
    await syncSkillsFromSnapshot(repo, snap);
    const result = await syncSkillsFromSnapshot(repo, snap, { overwrite: ["greeting"] });
    expect(result.existing).toEqual([{ name: "greeting", differs: [] }]);
  });

  it("re-syncs when an attachment changes, and drops removed files", async () => {
    const { repo, store } = fakeRepo();
    await syncSkillsFromSnapshot(
      repo,
      withFiles([
        { path: "references/api.md", content: "# API" },
        { path: "references/old.md", content: "stale" },
      ]),
    );
    const result = await syncSkillsFromSnapshot(
      repo,
      withFiles([{ path: "references/api.md", content: "# API v2" }]),
      { overwrite: ["greeting"] },
    );
    expect(result.overwritten).toEqual(["greeting"]);
    expect(store.get("greeting")?.files).toEqual([{ path: "references/api.md", content: "# API v2" }]);
  });

  it("passes skipped attachments through to the result", async () => {
    const { repo } = fakeRepo();
    const snap = {
      ...snapshot,
      skipped: [{ name: "greeting", path: "big.md", reason: "too-large" as const }],
    };
    const result = await syncSkillsFromSnapshot(repo, snap);
    expect(result.skipped).toEqual([
      { name: "greeting", reason: "attachment", detail: "big.md: too-large" },
    ]);
  });
});

describe("parseSkillDoc folded scalars", () => {
  it("joins description folded with > across indented lines", () => {
    const doc = "---\nname: img\ndescription: >\n  First part of text.\n  Second part.\n---\nBody";
    expect(parseSkillDoc(doc).description).toBe("First part of text. Second part.");
  });
});
