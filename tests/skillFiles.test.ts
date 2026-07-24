import { describe, expect, it } from "vitest";
import {
  normalizeSkillFilePath,
  resolveSkillFile,
  selectSkillAttachments,
  type SkillRoot,
  type SkillTreeEntry,
} from "@/domain/skill/files";
import type { SkillFile } from "@/domain/skill/types";

describe("normalizeSkillFilePath", () => {
  it("accepts a clean nested relative path", () => {
    expect(normalizeSkillFilePath("references/api.md")).toEqual({
      ok: true,
      path: "references/api.md",
    });
  });

  it.each([
    ["", "empty"],
    ["/etc/passwd", "absolute"],
    ["C:/win.txt", "absolute"],
    ["a\\b.txt", "backslash"],
    ["../secrets.md", "traversal"],
    ["references/../../x.md", "traversal"],
    ["references//api.md", "empty"],
    ["./api.md", "empty"],
  ])("rejects %j as %s", (input, reason) => {
    expect(normalizeSkillFilePath(input)).toEqual({ ok: false, reason });
  });
});

describe("resolveSkillFile", () => {
  const files: SkillFile[] = [{ path: "references/api.md", content: "# API" }];

  it("returns the exact file content", () => {
    expect(resolveSkillFile(files, "references/api.md")).toEqual({ ok: true, content: "# API" });
  });

  it("rejects a traversal path as invalid", () => {
    expect(resolveSkillFile(files, "../other/SKILL.md")).toEqual({
      ok: false,
      reason: "invalid-path",
    });
  });

  it("rejects an unsupported extension", () => {
    expect(resolveSkillFile(files, "run.sh")).toEqual({ ok: false, reason: "unsupported-type" });
  });

  it("reports a missing file", () => {
    expect(resolveSkillFile(files, "references/missing.md")).toEqual({
      ok: false,
      reason: "not-found",
    });
  });
});

describe("selectSkillAttachments", () => {
  const root: SkillRoot = {
    name: "greeting",
    rootPath: "skills/greeting",
    skillMdPath: "skills/greeting/SKILL.md",
  };
  const blob = (path: string, extra: Partial<SkillTreeEntry> = {}): SkillTreeEntry => ({
    path,
    type: "blob",
    mode: "100644",
    size: 100,
    sha: `sha-${path}`,
    ...extra,
  });

  it("collects supported files under the root and excludes SKILL.md", () => {
    const { selected } = selectSkillAttachments(
      [
        blob("skills/greeting/SKILL.md"),
        blob("skills/greeting/references/api.md"),
        blob("skills/greeting/templates/reply.txt"),
      ],
      [root],
    );
    expect(selected.map((s) => s.relPath).sort()).toEqual([
      "references/api.md",
      "templates/reply.txt",
    ]);
  });

  it("skips symlinks, unsupported types, and oversized files with reasons", () => {
    const { selected, skipped } = selectSkillAttachments(
      [
        blob("skills/greeting/link.md", { mode: "120000" }),
        blob("skills/greeting/run.sh"),
        blob("skills/greeting/huge.md", { size: 999_999 }),
        blob("skills/greeting/ok.md"),
      ],
      [root],
    );
    expect(selected.map((s) => s.relPath)).toEqual(["ok.md"]);
    expect(skipped).toEqual([
      { name: "greeting", path: "huge.md", reason: "too-large" },
      { name: "greeting", path: "link.md", reason: "symlink" },
      { name: "greeting", path: "run.sh", reason: "unsupported-type" },
    ]);
  });

  it("enforces the per-skill file count cap", () => {
    const entries = Array.from({ length: 25 }, (_, i) =>
      blob(`skills/greeting/f${String(i).padStart(2, "0")}.md`),
    );
    const { selected, skipped } = selectSkillAttachments(entries, [root]);
    expect(selected).toHaveLength(20);
    expect(skipped.filter((s) => s.reason === "count-limit")).toHaveLength(5);
  });

  it("enforces the per-skill total size cap", () => {
    const entries = [
      blob("skills/greeting/a.md", { size: 60 * 1024 }),
      blob("skills/greeting/b.md", { size: 60 * 1024 }),
      blob("skills/greeting/c.md", { size: 60 * 1024 }),
      blob("skills/greeting/d.md", { size: 60 * 1024 }),
    ];
    const { selected, skipped } = selectSkillAttachments(entries, [root]);
    expect(selected).toHaveLength(3);
    expect(skipped).toEqual([{ name: "greeting", path: "d.md", reason: "size-limit" }]);
  });

  it("assigns files under a nested skill root to the nested skill", () => {
    const nested: SkillRoot = {
      name: "inner",
      rootPath: "skills/greeting/inner",
      skillMdPath: "skills/greeting/inner/SKILL.md",
    };
    const { selected } = selectSkillAttachments(
      [
        blob("skills/greeting/SKILL.md"),
        blob("skills/greeting/inner/SKILL.md"),
        blob("skills/greeting/inner/note.md"),
        blob("skills/greeting/top.md"),
      ],
      [root, nested],
    );
    const byName = Object.fromEntries(selected.map((s) => [s.relPath, s.name]));
    expect(byName["note.md"]).toBe("inner");
    expect(byName["top.md"]).toBe("greeting");
  });
});
