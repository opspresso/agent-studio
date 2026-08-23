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
import { describe, expect, it } from "vitest";
import { en } from "@/app/_i18n/messages/en";

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
});
