import { VIEW_URL_TTL_SECONDS } from "@/shared/artifactUrlTtl";

/**
 * How long a thread may go on tail reads before it re-reads everything.
 *
 * The tail read is what stopped every finished turn costing a full transcript
 * query — but it also stopped the thing that full read was quietly doing:
 * **re-signing every stored image and file in the thread.** Those addresses
 * are signed for `VIEW_URL_TTL_SECONDS` at read time, so a chat left open and
 * talked into for longer than that had its older pictures turn into
 * `AccessDenied`, with nothing on screen saying why and nothing short of a
 * reload fixing it.
 *
 * So the tail is the normal path and this is the ceiling on it: past this, the
 * next retire reads the whole thread again and every signature in it is fresh
 * once more. Half the TTL, so a signature minted just before a full read still
 * has half its life left when the next one comes.
 */
export const SIGNATURE_REFRESH_MS = (VIEW_URL_TTL_SECONDS * 1000) / 2;
