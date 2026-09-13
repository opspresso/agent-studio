import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { listModelMakers } from "@/domain/llm/models";
import { makerLogoPath } from "@/app/models/makerLogo";

/**
 * The makers come from the catalog snapshot; a maker agent-models adds needs
 * its mark copied here (`public/icons/brands/`), and this is what says so
 * after `pnpm sync-models` — the page hides a mark it cannot load, it does not
 * break, so nothing else would.
 */
describe("model maker logos", () => {
  it.each(["Qwen", "QWEN", " qwen "])("uses the existing Qwen icon for maker %s", (maker) => {
    expect(makerLogoPath(maker)).toBe("/icons/brands/qwen.svg");
  });

  it("has a local SVG for every maker the catalog names", () => {
    for (const maker of Object.keys(listModelMakers())) {
      expect(
        existsSync(`public${makerLogoPath(maker)}`),
        `${maker}: missing maker logo`,
      ).toBe(true);
    }
  });
});
