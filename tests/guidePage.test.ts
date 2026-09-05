/**
 * The guide page is nothing but message keys, which is what makes one trap
 * possible: a section written into both catalogues and never added to the
 * page's arrays type-checks, translates, and is read by nobody. The compiler
 * sees a key that exists; it cannot see a key nothing renders.
 *
 * So the invariant is the pair — every `guide.` key in the catalogue appears in
 * the page, and every key the page names is in the catalogue. The second half
 * `tsc` already enforces; asserting it here costs nothing and states the
 * contract in one place.
 */

import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { describe, expect, it, vi } from "vitest";
import { en } from "@/app/_i18n/messages/en";
import { getT } from "@/app/_i18n/server";
import { translator } from "@/app/_i18n/translate";
import GuidePage from "@/app/guide/page";
import { theme } from "@/app/theme";

vi.mock("@/app/_i18n/server", () => ({ getT: vi.fn() }));

const page = readFileSync(new URL("../src/app/guide/page.tsx", import.meta.url), "utf8");
const catalogue = Object.keys(en).filter((key) => key.startsWith("guide."));

describe("the guide page", () => {
  it("renders every guide message the catalogue carries", () => {
    const unrendered = catalogue.filter((key) => !page.includes(`"${key}"`));
    expect(unrendered).toEqual([]);
  });

  it("names only messages the catalogue carries", () => {
    const named = [...page.matchAll(/"(guide\.[A-Za-z.]+)"/g)].map((match) => match[1]!);
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((key) => !catalogue.includes(key))).toEqual([]);
  });

  it.each(["en", "ko"] as const)("renders readable sections and working contents in %s", async (locale) => {
    const t = translator(locale);
    vi.mocked(getT).mockResolvedValue(t);
    const html = renderToStaticMarkup(
      createElement(MantineProvider, { theme, children: await GuidePage() }),
    );
    const targets = [...html.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]!);
    const sections = [...html.matchAll(/<section[^>]* id="([^"]+)"/g)].map((match) => match[1]!);
    expect(targets.length).toBeGreaterThan(0);
    expect(targets).toEqual(sections);
    expect(new Set(targets).size).toBe(targets.length);
    for (const id of targets) {
      expect(html).toContain(`aria-labelledby="${id}-title"`);
      expect(html).toMatch(new RegExp(`<h2[^>]*id="${id}-title"`));
    }
    expect(html).toContain(t("guide.contents"));
    expect(html).toContain(t("guide.install.title"));
    expect(html).toContain(t("guide.operations.title"));
    expect(html).not.toMatch(/(?:href|src)="https?:\/\//);
    expect(html).not.toContain("docs/");
  });
});
