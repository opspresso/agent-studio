/**
 * Which transfer chains the console shows. Two different questions — what this run
 * reached, and what is running right now — so two sets of rules; answering both
 * with one is how a finished subagent stayed on screen as "running".
 */

import { describe, expect, it } from "vitest";
import { mergeVisitedPath, trackActivePath } from "@/app/_lib/authorPaths";
import { reduceChunk } from "@/app/chats/_lib/stream";
import { EMPTY_TURN } from "@/app/chats/_lib/types";

describe("mergeVisitedPath — every chain this run reached", () => {
  it("keeps chains that are not nested in each other", () => {
    let paths = mergeVisitedPath([], ["alpha"]);
    paths = mergeVisitedPath(paths, ["beta"]);
    expect(paths).toEqual([["alpha"], ["beta"]]);
  });

  it("replaces a chain with the deeper one that extends it", () => {
    let paths = mergeVisitedPath([], ["parent"]);
    paths = mergeVisitedPath(paths, ["parent", "child"]);
    expect(paths).toEqual([["parent", "child"]]);
  });

  it("keeps the deeper chain when the shallower one speaks again", () => {
    // Right for history: the run did reach `parent → child`, and listing `parent`
    // as well would read as two separate agents. The active set does the opposite.
    let paths = mergeVisitedPath([], ["parent", "child"]);
    paths = mergeVisitedPath(paths, ["parent"]);
    expect(paths).toEqual([["parent", "child"]]);
  });

  it("does not read a name prefix as a chain prefix", () => {
    let paths = mergeVisitedPath([], ["img"]);
    paths = mergeVisitedPath(paths, ["image-agent"]);
    expect(paths).toEqual([["img"], ["image-agent"]]);
  });
});

describe("trackActivePath — the chains running now", () => {
  it("drops a nested chain when its parent takes control back", () => {
    // A transfer blocks, so the parent speaking again means the child returned.
    expect(trackActivePath([["alpha", "researcher"]], ["alpha"])).toEqual([["alpha"]]);
  });

  it("deepens a chain when the child starts speaking", () => {
    expect(trackActivePath([["alpha"]], ["alpha", "researcher"])).toEqual([
      ["alpha", "researcher"],
    ]);
  });

  it("keeps chains that are not nested side by side", () => {
    let paths = trackActivePath([], ["alpha"]);
    paths = trackActivePath(paths, ["beta"]);
    paths = trackActivePath(paths, ["gamma"]);
    expect(paths).toEqual([["alpha"], ["beta"], ["gamma"]]);
  });

  it("does not read a name prefix as a chain prefix", () => {
    let paths = trackActivePath([], ["img"]);
    paths = trackActivePath(paths, ["image-agent"]);
    expect(paths).toEqual([["img"], ["image-agent"]]);
  });
});

describe("reduceChunk author tracking", () => {
  it("holds every chain that is speaking at once", () => {
    let turn = reduceChunk(EMPTY_TURN, { author: "alpha", delta: { content: "a" } });
    turn = reduceChunk(turn, { author: "beta", delta: { content: "b" } });

    expect(turn.authorPaths).toEqual([["alpha"], ["beta"]]);
    // Subagent text still stays out of the visible answer.
    expect(turn.text).toBe("");
  });

  it("clears them when the top-level agent speaks again", () => {
    let turn = reduceChunk(EMPTY_TURN, { author: "alpha", delta: { content: "a" } });
    turn = reduceChunk(turn, { author: "beta", delta: { content: "b" } });
    turn = reduceChunk(turn, { delta: { content: "done" } });

    expect(turn.authorPaths).toEqual([]);
    expect(turn.text).toBe("done");
  });

  it("drops a nested agent once its parent takes control back", () => {
    // Keeping the deeper chain is right for "agents involved" and wrong for
    // "running now" — the badge would claim a finished agent is still going.
    let turn = reduceChunk(EMPTY_TURN, {
      author: "researcher",
      authorPath: ["alpha", "researcher"],
      delta: { content: "r" },
    });
    turn = reduceChunk(turn, { author: "alpha", delta: { content: "a" } });

    expect(turn.authorPaths).toEqual([["alpha"]]);
  });

  it("takes the whole chain from authorPath, not just the innermost author", () => {
    const turn = reduceChunk(EMPTY_TURN, {
      author: "child",
      authorPath: ["parent", "child"],
      delta: { content: "x" },
    });

    expect(turn.authorPaths).toEqual([["parent", "child"]]);
  });

  it("renders a dispatched group's tool result while its children are still listed", () => {
    let turn = reduceChunk(EMPTY_TURN, { author: "alpha", delta: { content: "a" } });
    turn = reduceChunk(turn, { author: "beta", delta: { content: "b" } });
    turn = reduceChunk(turn, {
      toolResult: { name: "dispatch_agents", content: "### alpha\ndone" },
    });

    expect(turn.tools).toHaveLength(1);
    expect(turn.tools[0]?.name).toBe("dispatch_agents");
    // The result is the parent's, but it arrives unauthored — control is back.
    expect(turn.authorPaths).toEqual([]);
  });
});
