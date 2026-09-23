/**
 * What a gallery page says about the page after it.
 *
 * A mapper that sees only the last returned row sets a cursor for every
 * non-empty page — so three pictures offer "Load more" and
 * the click paid for up to five DynamoDB queries and a signing fan-out to come
 * back empty. The page is asked for one row past its size now, and that row is
 * the whole evidence.
 */

import { describe, expect, it } from "vitest";
import {
  parseArtifactQuery,
  probeFor,
  toArtifactViews,
} from "@/app/api/artifacts/_lib/query";
import { MAX_ARTIFACT_PAGE } from "@/application/artifact/artifactUseCases";
import { artifactCursor } from "@/domain/artifact/repository";
import type { Artifact } from "@/domain/artifact/types";

function rows(count: number): Artifact[] {
  return Array.from({ length: count }, (_, at) => ({
    artifactId: `a${at}`,
    projectName: "demo",
    kind: "image" as const,
    source: "generated" as const,
    mimeType: "image/png",
    key: `artifacts/a${at}.png`,
    byteSize: 1,
    actor: { kind: "user" as const, id: "someone@example.com" },
    createdAt: `2026-08-2${at % 10}T00:00:00.000Z`,
  }));
}

function optionsOf(query: string) {
  const parsed = parseArtifactQuery(`https://example.com/api/artifacts${query}`);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  return parsed.options;
}

describe("an artifact page", () => {
  it("asks for one row more than it will show", () => {
    expect(probeFor(optionsOf("?limit=3")).limit).toBe(4);
    // Nothing to ask for past the largest page: the use case clamps there.
    expect(probeFor(optionsOf(`?limit=${MAX_ARTIFACT_PAGE}`)).limit).toBe(MAX_ARTIFACT_PAGE);
  });

  it("carries no cursor when the probe row never came back", async () => {
    const page = await toArtifactViews(rows(2), undefined, optionsOf("?limit=3"));
    expect(page.artifacts).toHaveLength(2);
    expect(page.nextBefore).toBeUndefined();
  });

  it("carries no cursor for a page that is exactly full and has nothing behind it", async () => {
    const page = await toArtifactViews(rows(3), undefined, optionsOf("?limit=3"));
    expect(page.artifacts).toHaveLength(3);
    expect(page.nextBefore).toBeUndefined();
  });

  it("keeps the probe row out of the page and points the cursor at the last kept row", async () => {
    const all = rows(4);
    const page = await toArtifactViews(all, undefined, optionsOf("?limit=3"));
    expect(page.artifacts.map((a) => a.artifactId)).toEqual(["a0", "a1", "a2"]);
    expect(page.nextBefore).toBe(artifactCursor(all[2]!));
  });

  it("does not sign the probe row", async () => {
    const signed: string[] = [];
    const page = await toArtifactViews(
      rows(4),
      async (key) => {
        signed.push(key);
        return `https://signed.example/${key}`;
      },
      optionsOf("?limit=3"),
    );
    expect(signed).toEqual(["artifacts/a0.png", "artifacts/a1.png", "artifacts/a2.png"]);
    expect(page.artifacts.every((a) => a.url !== undefined)).toBe(true);
  });

  it("still offers a cursor at the largest page, where no probe fits", async () => {
    const all = rows(MAX_ARTIFACT_PAGE);
    const page = await toArtifactViews(all, undefined, optionsOf(`?limit=${MAX_ARTIFACT_PAGE}`));
    expect(page.artifacts).toHaveLength(MAX_ARTIFACT_PAGE);
    expect(page.nextBefore).toBe(artifactCursor(all.at(-1)!));
  });
});
