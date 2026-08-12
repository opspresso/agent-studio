/**
 * How long a signed object URL lives, by who is going to fetch it.
 *
 * Two readers, two answers, and the difference is load-bearing rather than
 * cosmetic. It sits in the artifact slice rather than the chat one because there
 * are three readers now — the chat view, the replay, and the artifacts gallery —
 * and the gallery is looking at the same objects.
 */

import { MAX_RUN_DURATION_MS } from "@/shared/runDeadline";

/**
 * A chat view. The person already has the page open; a short window is enough,
 * and a page left open overnight re-reads the chat before it can show anything
 * anyway.
 */
export const VIEW_URL_TTL_SECONDS = 15 * 60;

/**
 * A replay. The URL goes into a turn the **provider** fetches, not the browser,
 * and it does so at whatever point in the run it gets to that message — which
 * may be at the very end of one that is allowed to last `MAX_RUN_DURATION_MS`.
 * A signature that expired mid-run would fail the turn on an image the user can
 * see in their own transcript, so the floor is the whole run plus a margin for
 * the provider's own queueing.
 *
 * Derived, never written down as a number: the run deadline is configurable, and
 * a hardcoded lifetime would silently become too short the first time someone
 * raised it.
 */
export const REPLAY_URL_TTL_SECONDS = Math.ceil(MAX_RUN_DURATION_MS / 1000) + 15 * 60;
