import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

/**
 * The pattern as a regex.
 *
 * The rule's `source` is written as one, so this is the pattern itself rather
 * than a restatement of it. A `source` rewritten in path-to-regexp's own syntax
 * (`/:path*`) fails the "covers the console" case below rather than passing
 * quietly — which is the right outcome: it has to be re-checked against a real
 * response, not assumed.
 */
async function consoleHeaderPattern(): Promise<RegExp> {
  const rules = await nextConfig.headers!();
  expect(rules).toHaveLength(1);
  return new RegExp(`^${rules[0]!.source}$`);
}

describe("which responses get the console's security headers", () => {
  it("covers the console, including pages nobody has written yet", async () => {
    const pattern = await consoleHeaderPattern();
    for (const path of ["/", "/artifacts", "/projects/p/versions", "/api/chats", "/whatever/next"]) {
      expect(pattern.test(path)).toBe(true);
    }
  });

  it("leaves the one route that sets its own policy alone", async () => {
    // A header declared in `next.config.ts` **replaces** what a route handler
    // set under the same key. While this matched, `/view` answered with
    // `frame-ancestors 'none'` instead of its sandbox, and an artifact's markup
    // ran on the console's origin with its cookies in reach — the whole reason
    // that route serves bytes rather than a signed URL was a header it turned
    // out not to be sending.
    const pattern = await consoleHeaderPattern();
    expect(pattern.test("/api/artifacts/ab0befd8-fb5d-4cd7-89af-ccf829a8e4d7/view")).toBe(false);
    expect(pattern.test("/api/artifacts/a1/view")).toBe(false);
  });

  it("still covers the artifact routes either side of it", async () => {
    // The exclusion is one address, not a subtree: listing and deleting are
    // ordinary console traffic and keep the console's headers.
    const pattern = await consoleHeaderPattern();
    expect(pattern.test("/api/artifacts")).toBe(true);
    expect(pattern.test("/api/artifacts/a1")).toBe(true);
    expect(pattern.test("/api/artifacts/a1/view/extra")).toBe(true);
  });
});
