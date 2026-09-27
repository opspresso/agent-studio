import { VIEW_URL_TTL_SECONDS } from "@/shared/artifactUrlTtl";

/**
 * How long a thread may go on tail reads before it re-reads everything.
 *
 * Tail reads retain older signed image and file addresses. After half their
 * TTL, the next sync performs a full read to refresh those signatures.
 */
export const SIGNATURE_REFRESH_MS = (VIEW_URL_TTL_SECONDS * 1000) / 2;
