/**
 * `collectedWarning`: the single owned decision of which warning chunks count
 * toward a run's collected losses. Seven consumers had each decided for
 * themselves and split three ways — top-level-only on two surfaces, duplicates
 * on three.
 */

import { describe, expect, it } from "vitest";
import { collectedWarning } from "@/domain/llm/types";

describe("collectedWarning", () => {
  it("keeps a top-level warning", () => {
    expect(collectedWarning({ warning: "lost a binding" }, [])).toBe("lost a binding");
  });

  it("keeps an authored warning — a subagent's loss is the caller's too", () => {
    const chunk = { author: "child", warning: "child lost its skill" };
    expect(collectedWarning(chunk, [])).toBe("child lost its skill");
  });

  it("drops what the reader was already told", () => {
    expect(collectedWarning({ warning: "same loss" }, ["same loss"])).toBeUndefined();
  });

  it("adds nothing for a chunk that carries no warning", () => {
    expect(collectedWarning({}, ["earlier"])).toBeUndefined();
    expect(collectedWarning({ warning: "" }, [])).toBeUndefined();
  });
});
