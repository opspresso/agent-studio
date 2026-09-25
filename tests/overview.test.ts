import { describe, expect, it } from "vitest";
import type { Agent } from "@/domain/agent/types";
import { recentAgents } from "@/app/_lib/overview";

function agent(name: string, ownerEmail: string, updatedAt: string): Agent {
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

describe("recentAgents", () => {
  it("puts the viewer's own first, however recent the others are", () => {
    const agents = [
      agent("theirs-newest", theirs, "2026-03-01T00:00:00.000Z"),
      agent("mine-older", mine, "2026-01-05T00:00:00.000Z"),
    ];
    expect(recentAgents(agents, mine, 10).map((p) => p.name)).toEqual([
      "mine-older",
      "theirs-newest",
    ]);
  });

  it("sorts each group by updatedAt, newest first", () => {
    const agents = [
      agent("mine-old", mine, "2026-01-01T00:00:00.000Z"),
      agent("theirs-old", theirs, "2026-01-02T00:00:00.000Z"),
      agent("mine-new", mine, "2026-02-01T00:00:00.000Z"),
      agent("theirs-new", theirs, "2026-02-02T00:00:00.000Z"),
    ];
    expect(recentAgents(agents, mine, 10).map((p) => p.name)).toEqual([
      "mine-new",
      "mine-old",
      "theirs-new",
      "theirs-old",
    ]);
  });

  it("keeps at most `limit`, dropping the far end rather than the viewer's own", () => {
    const agents = [
      agent("theirs-a", theirs, "2026-03-01T00:00:00.000Z"),
      agent("theirs-b", theirs, "2026-03-02T00:00:00.000Z"),
      agent("mine", mine, "2026-01-01T00:00:00.000Z"),
    ];
    expect(recentAgents(agents, mine, 2).map((p) => p.name)).toEqual(["mine", "theirs-b"]);
  });

  it("treats every agent as someone else's when the viewer is unknown", () => {
    const agents = [
      agent("older", mine, "2026-01-01T00:00:00.000Z"),
      agent("newer", theirs, "2026-02-01T00:00:00.000Z"),
    ];
    expect(recentAgents(agents, null, 10).map((p) => p.name)).toEqual(["newer", "older"]);
  });

  it("returns nothing for an empty catalog", () => {
    expect(recentAgents([], mine, 4)).toEqual([]);
  });
});
