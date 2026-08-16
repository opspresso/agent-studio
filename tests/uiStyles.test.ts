import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const globals = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
const layout = readFileSync(new URL("../src/app/layout.tsx", import.meta.url), "utf8");

describe("disabled input legibility", () => {
  it("keeps every Mantine input shell at full opacity with readable ink", () => {
    const start = globals.indexOf(".mantine-Input-input:disabled,");
    const rule = globals.slice(start, globals.indexOf("\n}", start));

    expect(start).toBeGreaterThan(-1);
    expect(rule).toContain(".mantine-Input-input[data-disabled]");
    expect(rule).toContain(".mantine-Input-input:has(input:disabled)");
    expect(rule).toContain("opacity: 1");
    expect(rule).toContain("color: var(--mantine-color-dimmed)");
    expect(rule).toContain("-webkit-text-fill-color: var(--mantine-color-dimmed)");
  });

  it("loads the shared override after Mantine core styles", () => {
    expect(layout.indexOf('import "@mantine/core/styles.css"')).toBeLessThan(
      layout.indexOf('import "./globals.css"'),
    );
  });
});
