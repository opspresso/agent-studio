/**
 * Which transfer chains the console shows as running. With `dispatch_agents`
 * several of them speak at the same time, so this is a set, not one slot.
 */

import { describe, expect, it } from "vitest";
import { mergeAuthorPath } from "@/app/_lib/authorPaths";
import { reduceChunk } from "@/app/chats/_lib/stream";
import { EMPTY_TURN } from "@/app/chats/_lib/types";

describe("mergeAuthorPath", () => {
  it("keeps chains that are not nested in each other", () => {
    let paths = mergeAuthorPath([], ["alpha"]);
    paths = mergeAuthorPath(paths, ["beta"]);
    expect(paths).toEqual([["alpha"], ["beta"]]);
  });

  it("replaces a chain with the deeper one that extends it", () => {
    let paths = mergeAuthorPath([], ["parent"]);
    paths = mergeAuthorPath(paths, ["parent", "child"]);
    expect(paths).toEqual([["parent", "child"]]);
  });

  it("keeps the deeper chain when the shallower one speaks again", () => {
    let paths = mergeAuthorPath([], ["parent", "child"]);
    paths = mergeAuthorPath(paths, ["parent"]);
    expect(paths).toEqual([["parent", "child"]]);
  });

  it("does not read a name prefix as a chain prefix", () => {
    let paths = mergeAuthorPath([], ["img"]);
    paths = mergeAuthorPath(paths, ["image-agent"]);
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
