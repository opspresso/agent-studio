import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MODEL_MAKER_LABELS } from "@/domain/llm/models";

describe("model maker logos", () => {
  it("has a local SVG for every registered maker", () => {
    for (const maker of Object.keys(MODEL_MAKER_LABELS)) {
      expect(
        existsSync(`public/icons/brands/${maker}.svg`),
        `${maker}: missing maker logo`,
      ).toBe(true);
    }
  });
});
