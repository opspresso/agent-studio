import { createHmac } from "node:crypto";
import { timingSafeEqualString } from "@/shared/timingSafe";

const VERSION = "v0";
const MAX_SKEW_SECONDS = 60 * 5;

/**
 * Verify a Slack request signature (X-Slack-Signature / X-Slack-Request-Timestamp).
 * Rejects stale timestamps to block replay.
 */
export function verifySlackSignature(input: {
  signingSecret: string;
  body: string;
  timestamp: string | null;
  signature: string | null;
  nowSeconds?: number;
}): boolean {
  const { signingSecret, body, timestamp, signature } = input;
  if (!timestamp || !signature) {
    return false;
  }
  const ts = Number(timestamp);
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_SKEW_SECONDS) {
    return false;
  }
  const expected = `${VERSION}=${createHmac("sha256", signingSecret)
    .update(`${VERSION}:${timestamp}:${body}`)
    .digest("hex")}`;
  return timingSafeEqualString(expected, signature);
}
