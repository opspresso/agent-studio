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

/** One page of a gallery — what both listing routes answer with. */
export interface ArtifactPage {
  artifacts: ArtifactView[];
  /**
   * Cursor for the next page, absent once there is nothing further back — see
   * {@link probeFor} for the one case that can still be one page out.
   */
  nextBefore?: string;
}

/** The page size a request asked for, clamped exactly as the use case clamps it. */
function pageSize(options: ListArtifactsOptions): number {
  return Math.min(Math.max(options.limit ?? DEFAULT_ARTIFACT_PAGE, 1), MAX_ARTIFACT_PAGE);
}

/**
 * The listing options with room for **one row past the page**, which is how a
 * page tells "this is the last one" from "there is another".
 *
 * Without it every non-empty page carried a cursor, because the only thing this
 * file could see was that some row was last — so a gallery holding three
 * pictures offered "Load more", and the click cost up to five DynamoDB queries
 * and a signing fan-out to answer with nothing.
 *
 * The probe row is fetched, never rendered and never signed. At
 * `MAX_ARTIFACT_PAGE` there is no room for it (the use case clamps there), so
 * the largest page falls back to "a full page may have more" — one empty
 * follow-up remains possible when the total is an exact multiple of it.
 */
export function probeFor(options: ListArtifactsOptions): ListArtifactsOptions {
  return { ...options, limit: probeSize(options) };
}

/** How many rows to ask for: the page and its probe, where there is room. */
function probeSize(options: ListArtifactsOptions): number {
  return Math.min(pageSize(options) + 1, MAX_ARTIFACT_PAGE);
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
  /** Rows as {@link probeFor} asked for them: the page, plus at most one more. */
  rows: Artifact[],
  sign: SignObjectUrl | undefined,
  options: ListArtifactsOptions,
): Promise<ArtifactPage> {
  const limit = pageSize(options);
  const artifacts = rows.slice(0, limit);
  // `>=` rather than `>`: at the largest page the probe had nowhere to go, and a
  // page that came back full is the only evidence left that more may follow.
  const more = rows.length >= probeSize(options);
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
    ...(more && last ? { nextBefore: artifactCursor(last) } : {}),
  };
}
