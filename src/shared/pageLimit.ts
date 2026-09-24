/**
 * How a caller's page size is read off a request, and how large a page may get.
 *
 * Four list endpoints wrote this out for themselves, and the copies disagreed
 * about the same three inputs. `?limit=` — a query string built from a value
 * that turned out to be absent, which is how it is usually produced — is `""`
 * rather than `null`, so `??` does not reach the default and `Number("")` is
 * `0`; clamped up to one, three of the four answered a gallery request with a
 * single row and reported it as the page that was asked for. `?limit=1.5`
 * fell back to the default in three and floored in the fourth. `?limit=0.5`
 * floored to a page of zero and then, because a zero-length page is trivially
 * "full", offered "load more" against a list that could not grow.
 *
 * The reading below is the chats endpoint's, which is the one that was right:
 * anything that is not a whole page size at least one is *absent*, not zero.
 * It is here rather than in `app/api/_lib` because the repositories bound the
 * same number on the way in, and `shared` is the one floor all three layers
 * that touch a page can reach.
 */

/**
 * The largest page a list endpoint asks a repository for.
 *
 * A ceiling on one read, not on what a reader may eventually see — every
 * surface that uses it pages. Endpoints whose page size is a decision of its
 * own (a gallery's tiles, the chat sidebar) pass their own `max`; this is the
 * number for the ones that have no reason to differ.
 */
export const MAX_PAGE_LIMIT = 100;

/** What a request asked for, and what it is allowed to get. */
export interface RequestedPage {
  /**
   * The size asked for, uncapped.
   *
   * Kept because "is there another page" is answered against it and not
   * against the ceiling: past the ceiling the two differ, and a reader at the
   * ceiling would otherwise be offered "load more" forever against a list that
   * cannot grow.
   */
  wanted: number;
  /** What to read: {@link wanted}, capped. */
  limit: number;
}

/**
 * Put a page size in range: a whole number from 1 to `max`.
 *
 * A size that is not finite reads as *unstated* and takes the
 * ceiling, which is the safe direction — the failure the other way is a page
 * of one row that looks like the end of the list. Callers that read the size
 * off a request never produce one; {@link parsePageLimit} has already
 * resolved it.
 */
export function boundedPageLimit(limit: number, max: number = MAX_PAGE_LIMIT): number {
  if (!Number.isFinite(limit)) {
    return max;
  }
  return Math.min(Math.max(Math.floor(limit), 1), max);
}

/**
 * Read `?limit=` off a request.
 *
 * `raw` is the query parameter as it came — `null` when it was not given at
 * all, and possibly `""` when it was given empty. Both are absent, as are
 * non-finite numbers and values below one; those take `fallback`. Finite
 * fractional values of at least one are floored to a whole page size.
 */
export function parsePageLimit(
  raw: string | null,
  options: { fallback: number; max?: number },
): RequestedPage {
  const max = options.max ?? MAX_PAGE_LIMIT;
  const asked = raw === null || raw.trim() === "" ? Number.NaN : Number(raw);
  const wanted = Number.isFinite(asked) && asked >= 1 ? Math.floor(asked) : options.fallback;
  // Through the clamp rather than a bare `Math.min`, so "a page holds at least
  // one row" holds whatever an endpoint declared as its default. For every
  // `wanted` that got here from the line above the two are the same number.
  return { wanted, limit: boundedPageLimit(wanted, max) };
}
