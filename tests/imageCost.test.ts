import { describe, expect, it } from "vitest";
import { calculateImageCost } from "@/domain/llm/models";

describe("calculateImageCost", () => {
  it("returns 0 for unknown models", () => {
    expect(
      calculateImageCost("nope/none", {
        textInputTokens: 1,
        imageInputTokens: 1,
        imageOutputTokens: 1,
      }),
    ).toBe(0);
  });
});
