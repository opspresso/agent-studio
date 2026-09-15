import { createHmac } from "node:crypto";
import { timingSafeEqualString } from "./timingSafe";

/** GitHub signs the original UTF-8 body, including whitespace, with HMAC-SHA256. */
export function verifyGitHubSignature(secret: string | undefined, body: string, signature: string | null): boolean {
  if (!secret || !signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  return timingSafeEqualString(signature, `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`);
}

export function isGitHubDeliveryId(value: string | null): value is string {
  return value !== null && /^[a-zA-Z0-9_-]{8,160}$/.test(value);
}
