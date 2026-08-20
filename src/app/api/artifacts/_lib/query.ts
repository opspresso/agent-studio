/**
 * The query and the response shape both artifact listings share.
 *
 * Two routes read the same rows down two different indexes — a person's own
 * gallery and a project's — and a filter parsed differently by one of them would
 * be a gallery that disagrees with itself about what "images only" means.
 */

import { VIEW_URL_TTL_SECONDS } from "@/application/artifact/urlTtl";
import {
  DEFAULT_ARTIFACT_PAGE,
  MAX_ARTIFACT_PAGE,
} from "@/application/artifact/artifactUseCases";
import { artifactCursor } from "@/domain/artifact/repository";
import type { ListArtifactsOptions } from "@/domain/artifact/repository";
import type { Artifact, ArtifactKind, ArtifactSource } from "@/domain/artifact/types";
import type { SignObjectUrl } from "@/domain/artifact/objectStore";
import { isUtcDay } from "@/shared/date";

export type ParsedQuery =
  | { ok: true; options: ListArtifactsOptions }
  | { ok: false; error: string };

/** Told apart from "absent" so an empty `?kind=` filters nothing rather than 400s. */
const INVALID = Symbol("invalid");

function oneOf<T extends string>(raw: string | null, allowed: readonly T[]): T | undefined | typeof INVALID {
  if (!raw) {
    return undefined;
  }
  return allowed.includes(raw as T) ? (raw as T) : INVALID;
}

export function parseArtifactQuery(url: string): ParsedQuery {
  const params = new URL(url).searchParams;
  // The clamp the use case already owns. Spelled here as literals, the route
  // and the use case were free to disagree about page size — which this file's
  // own header warns about for every other filter it parses.
  const rawLimit = Number(params.get("limit") ?? DEFAULT_ARTIFACT_PAGE);
  const limit = Number.isInteger(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), MAX_ARTIFACT_PAGE)
    : DEFAULT_ARTIFACT_PAGE;
  const from = params.get("from") || undefined;
  const to = params.get("to") || undefined;
  // `isUtcDay`, not a shape regex: `2026-02-31` would otherwise ride into the
  // GSI range condition as written and silently widen the window.
  if ((from && !isUtcDay(from)) || (to && !isUtcDay(to)) || (from && to && from > to)) {
    return { ok: false, error: "from/to must be YYYY-MM-DD with from ≤ to" };
  }
  const kind = oneOf(params.get("kind"), ["image", "document"] as const);
  if (kind === INVALID) {
    return { ok: false, error: "kind must be image or document" };
  }
  const source = oneOf(params.get("source"), ["generated", "attachment"] as const);
  if (source === INVALID) {
    return { ok: false, error: "source must be generated or attachment" };
  }
  return {
    ok: true,
    options: {
      limit,
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(params.get("before") ? { before: params.get("before")! } : {}),
      ...(kind ? { kind } : {}),
      ...(source ? { source } : {}),
    },
  };
}

export interface ArtifactView extends Artifact {
  /** A readable address, or absent when address resolution failed. */
  url?: string;
}

/**
 * The rows plus an address for each.
 *
 * Resolved inline rather than behind a second request per thumbnail. In
 * authenticated mode, presigning is local and adds no S3 round trip.
 *
 * A document is signed to download under its own name, in both access modes —
 * which is why a public deployment's document tiles carry a time-limited URL
 * while its images keep the permanent one.
 */
export async function toArtifactViews(
  artifacts: Artifact[],
  sign: SignObjectUrl | undefined,
): Promise<{ artifacts: ArtifactView[]; nextBefore?: string }> {
  const views = await Promise.all(
    artifacts.map(async (artifact) => {
      if (!sign) {
        return artifact;
      }
      try {
        const url = await sign(
          artifact.key,
          VIEW_URL_TTL_SECONDS,
          artifact.kind === "document"
            ? { downloadAs: artifact.filename ?? `${artifact.artifactId}` }
            : undefined,
        );
        return { ...artifact, url };
      } catch {
        // One address that could not be minted is one broken tile, not a failed
        // page — and the tile says so rather than rendering a dead image.
        return artifact;
      }
    }),
  );
  const last = artifacts.at(-1);
  return {
    artifacts: views,
    // The sort key is the cursor, spelled by the repository port so this and the
    // adapter that compares it cannot drift.
    ...(last ? { nextBefore: artifactCursor(last) } : {}),
  };
}
