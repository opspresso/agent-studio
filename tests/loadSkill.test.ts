import { describe, expect, it } from "vitest";
import { loadSkillFileContent } from "@/application/skill/loadSkill";
import type { Skill } from "@/domain/skill/types";

const skill: Skill = {
  name: "greeting",
  description: "Say hello",
  content: "# Greeting body",
  files: [{ path: "references/api.md", content: "# API reference" }],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

describe("loadSkillFileContent", () => {
  it("returns the SKILL.md body when no file_path is given", () => {
    expect(loadSkillFileContent(skill, "greeting")).toContain("# Greeting body");
    expect(loadSkillFileContent(skill, "greeting", "")).toContain("# Greeting body");
  });

  it("names the attachments after the body, so the next step is reachable", () => {
    // `file_path` is a free-text guess: a skill whose body never mentions its
    // own files had them stored and unreachable.
    const loaded = loadSkillFileContent(skill, "greeting");
    expect(loaded).toContain("references/api.md");
    expect(loaded).toContain("file_path");
  });

  it("loads an exact attachment file", () => {
    expect(loadSkillFileContent(skill, "greeting", "references/api.md")).toBe("# API reference");
  });

  it("returns an error for a missing skill", () => {
    expect(loadSkillFileContent(null, "greeting")).toContain("not found in database");
  });

  it("returns a distinct error for a traversal path", () => {
    expect(loadSkillFileContent(skill, "greeting", "../x.md")).toContain("path is invalid");
  });

  it("returns a distinct error for an unsupported type", () => {
    expect(loadSkillFileContent(skill, "greeting", "run.sh")).toContain("not supported");
  });

  it("returns a distinct error for a missing file", () => {
    expect(loadSkillFileContent(skill, "greeting", "references/missing.md")).toContain(
      "no such file",
    );
  });

  it("names what could have been asked for on every failed file load", () => {
    // The same answer an unknown agent, image id or skill name already gets.
    for (const requested of ["../x.md", "run.sh", "references/missing.md"]) {
      expect(loadSkillFileContent(skill, "greeting", requested)).toContain("references/api.md");
    }
  });

  it("says a skill has no files at all rather than listing nothing", () => {
    const bodyOnly: Skill = { ...skill, files: [] };
    const loaded = loadSkillFileContent(bodyOnly, "greeting", "references/api.md");
    expect(loaded).toContain("no such file");
    expect(loaded).toContain("has no files");
  });

  it("treats a skill with no files as body-only (backward compatible)", () => {
    const legacy: Skill = { ...skill, files: undefined };
    expect(loadSkillFileContent(legacy, "greeting")).toBe("# Greeting body");
    expect(loadSkillFileContent(legacy, "greeting", "references/api.md")).toContain("no such file");
  });
});
