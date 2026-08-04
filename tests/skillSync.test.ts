import { describe, expect, it } from "vitest";
import { parseSkillDoc, syncSkillsFromSnapshot } from "@/application/skill/syncSkills";
import type { Skill } from "@/domain/skill/types";
import type { SkillRepository } from "@/domain/skill/repository";
import type { SkillUseCases } from "@/application/skill/skillUseCases";

function fakeRepo(initial: Skill[] = []) {
  const store = new Map(initial.map((s) => [s.name, s]));
  const repo: SkillRepository = {
    async get(name) {
      return store.get(name) ?? null;
    },
    async describe(names) {
      return names.flatMap((name) => {
        const skill = store.get(name);
        return skill ? [{ name, description: skill.description }] : [];
      });
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
  // The sync writes through the repository and deletes through the use case, so
  // the fixture has to be both. Only `remove` is exercised here — it is the one
  // call that has to reach the owner of the `registry.delete` row.
  const removedBy: Array<{ name: string; actorEmail: string }> = [];
  const skills: Pick<SkillUseCases, "remove"> = {
    async remove(name, actorEmail) {
      removedBy.push({ name, actorEmail });
      store.delete(name);
    },
  };
  return { repo, skills, store, removedBy };
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

/** Every sync is asked for by somebody; the actor is what its deletions record. */
const ACTOR = "admin@example.com";

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
    const { repo, skills, store } = fakeRepo();
    const result = await syncSkillsFromSnapshot(repo, skills, snapshot, ACTOR);
    expect(result.created).toEqual(["greeting"]);
    expect(store.get("greeting")).toMatchObject({
      description: "Say hello",
      content: "Be warm.",
      source: "github:opspresso/agent-skills",
    });
  });

  it("keeps createdAt on resync and reports unchanged content", async () => {
    const { repo, skills, store } = fakeRepo([
      {
        name: "greeting",
        description: "Say hello",
        content: "Be warm.",
        source: "github:opspresso/agent-skills",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ]);
    const result = await syncSkillsFromSnapshot(repo, skills, snapshot, ACTOR, { overwrite: ["greeting"] });
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
    const { repo, skills, store } = fakeRepo([local]);
    await syncSkillsFromSnapshot(repo, skills, snapshot, ACTOR);
    expect(store.get("local-only")).toEqual(local);
  });

  const withFiles = (files: { path: string; content: string }[]) => ({
    ...snapshot,
    files: [{ ...snapshot.files[0]!, files }],
  });

  it("stores attachment files on sync", async () => {
    const { repo, skills, store } = fakeRepo();
    await syncSkillsFromSnapshot(
      repo,
      skills,
      withFiles([{ path: "references/api.md", content: "# API" }]),
      ACTOR,
    );
    expect(store.get("greeting")?.files).toEqual([{ path: "references/api.md", content: "# API" }]);
  });

  it("reports unchanged when attachment files are identical", async () => {
    const { repo, skills } = fakeRepo();
    const snap = withFiles([{ path: "references/api.md", content: "# API" }]);
    await syncSkillsFromSnapshot(repo, skills, snap, ACTOR);
    const result = await syncSkillsFromSnapshot(repo, skills, snap, ACTOR, { overwrite: ["greeting"] });
    expect(result.existing).toEqual([{ name: "greeting", differs: [] }]);
  });

  it("re-syncs when an attachment changes, and drops removed files", async () => {
    const { repo, skills, store } = fakeRepo();
    await syncSkillsFromSnapshot(
      repo,
      skills,
      withFiles([
        { path: "references/api.md", content: "# API" },
        { path: "references/old.md", content: "stale" },
      ]),
      ACTOR,
    );
    const result = await syncSkillsFromSnapshot(
      repo,
      skills,
      withFiles([{ path: "references/api.md", content: "# API v2" }]),
      ACTOR,
      { overwrite: ["greeting"] },
    );
    expect(result.overwritten).toEqual(["greeting"]);
    expect(store.get("greeting")?.files).toEqual([{ path: "references/api.md", content: "# API v2" }]);
  });

  const orphan: Skill = {
    name: "retired",
    description: "Gone from the branch",
    content: "old",
    source: "github:opspresso/agent-skills",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };

  it("reports a skill this sync created that the repo no longer carries", async () => {
    const { repo, skills, removedBy } = fakeRepo([orphan]);
    const result = await syncSkillsFromSnapshot(repo, skills, snapshot, ACTOR);
    expect(result.orphaned).toEqual(["retired"]);
    // The stored version may be a deliberate edit; a file disappearing from a
    // branch is not enough to delete one.
    expect(removedBy).toEqual([]);
  });

  it("deletes an orphan the caller named, through the use case and against them", async () => {
    // Through `skills.remove`, not `repo.delete`: that is the single owner of
    // the `registry.delete` row, and deleting around it left a skill removed by
    // a sync with no trace while the same removal from the console left one.
    const { repo, skills, store, removedBy } = fakeRepo([orphan]);
    const result = await syncSkillsFromSnapshot(repo, skills, snapshot, ACTOR, {
      remove: ["retired"],
    });
    expect(result.removed).toEqual(["retired"]);
    expect(removedBy).toEqual([{ name: "retired", actorEmail: ACTOR }]);
    expect(store.has("retired")).toBe(false);
  });

  it("never lists a skill someone wrote in the console", async () => {
    const { repo, skills } = fakeRepo([{ ...orphan, name: "typed-by-hand", source: undefined }]);
    const result = await syncSkillsFromSnapshot(repo, skills, snapshot, ACTOR);
    expect(result.orphaned).toEqual([]);
  });

  it("passes skipped attachments through to the result", async () => {
    const { repo, skills } = fakeRepo();
    const snap = {
      ...snapshot,
      skipped: [{ name: "greeting", path: "big.md", reason: "too-large" as const }],
    };
    const result = await syncSkillsFromSnapshot(repo, skills, snap, ACTOR);
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
