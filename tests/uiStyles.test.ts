import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const globals = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
const layout = readFileSync(new URL("../src/app/layout.tsx", import.meta.url), "utf8");
const appLayout = readFileSync(new URL("../src/components/AppLayout.tsx", import.meta.url), "utf8");
const appLayoutStyles = readFileSync(
  new URL("../src/components/AppLayout.module.css", import.meta.url),
  "utf8",
);

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

  it("hides the placeholder of a disabled input rather than dimming it", () => {
    // The pair the rule above makes necessary: legible disabled text turns a
    // placeholder into what looks like a stored value.
    const start = globals.indexOf(".mantine-Input-input:disabled::placeholder,");
    const rule = globals.slice(start, globals.indexOf("\n}", start));

    expect(start).toBeGreaterThan(-1);
    expect(rule).toContain(".mantine-Input-input[data-disabled]::placeholder");
    expect(rule).toContain(".mantine-Input-input:has(input:disabled) input::placeholder");
    expect(rule).toContain("color: transparent");
    expect(rule).toContain("-webkit-text-fill-color: transparent");
  });

  it("loads the shared override after Mantine core styles", () => {
    expect(layout.indexOf('import "@mantine/core/styles.css"')).toBeLessThan(
      layout.indexOf('import "./globals.css"'),
    );
  });

  it("uses AppShell's main landmark without nesting another one", () => {
    expect(appLayout).toContain('<AppShell.Main id="main-content" tabIndex={-1}>');
    expect(appLayout).toContain('href="#main-content"');
    expect(appLayout).toContain('<div className={classes.main}>{children}</div>');
    expect(appLayout).not.toContain("<main");
  });

  it("collapses the brand wordmark before the signed-out header clips", () => {
    expect(appLayout).toContain('<div className={classes.brandText}>');
    expect(appLayoutStyles).toMatch(
      /@media \(max-width: \$mantine-breakpoint-xs\)[\s\S]*?\.brandText \{[\s\S]*?display: none;/,
    );
  });
});
