import { describe, expect, it } from "vitest";
import type { Project } from "@/domain/project/types";
import { recentProjects } from "@/app/_lib/overview";

function project(name: string, ownerEmail: string, updatedAt: string): Project {
  return {
    name,
    displayName: name,
    description: "",
    ownerEmail,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
  };
}

const mine = "me@example.com";
const theirs = "them@example.com";

describe("recentProjects", () => {
  it("puts the viewer's own first, however recent the others are", () => {
    const projects = [
      project("theirs-newest", theirs, "2026-03-01T00:00:00.000Z"),
      project("mine-older", mine, "2026-01-05T00:00:00.000Z"),
    ];
    expect(recentProjects(projects, mine, 10).map((p) => p.name)).toEqual([
      "mine-older",
      "theirs-newest",
    ]);
  });

  it("sorts each group by updatedAt, newest first", () => {
    const projects = [
      project("mine-old", mine, "2026-01-01T00:00:00.000Z"),
      project("theirs-old", theirs, "2026-01-02T00:00:00.000Z"),
      project("mine-new", mine, "2026-02-01T00:00:00.000Z"),
      project("theirs-new", theirs, "2026-02-02T00:00:00.000Z"),
    ];
    expect(recentProjects(projects, mine, 10).map((p) => p.name)).toEqual([
      "mine-new",
      "mine-old",
      "theirs-new",
      "theirs-old",
    ]);
  });

  it("keeps at most `limit`, dropping the far end rather than the viewer's own", () => {
    const projects = [
      project("theirs-a", theirs, "2026-03-01T00:00:00.000Z"),
      project("theirs-b", theirs, "2026-03-02T00:00:00.000Z"),
      project("mine", mine, "2026-01-01T00:00:00.000Z"),
    ];
    expect(recentProjects(projects, mine, 2).map((p) => p.name)).toEqual(["mine", "theirs-b"]);
  });

  it("treats every project as someone else's when the viewer is unknown", () => {
    const projects = [
      project("older", mine, "2026-01-01T00:00:00.000Z"),
      project("newer", theirs, "2026-02-01T00:00:00.000Z"),
    ];
    expect(recentProjects(projects, null, 10).map((p) => p.name)).toEqual(["newer", "older"]);
  });

  it("returns nothing for an empty catalog", () => {
    expect(recentProjects([], mine, 4)).toEqual([]);
  });
});
