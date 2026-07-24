import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Project API token helpers. Tokens authenticate execution requests via the
 * `Authorization: Bearer <token>` header. Only the SHA-256 hash is ever stored;
 * the raw value is returned once at generation and cannot be recovered.
 */

const TOKEN_PREFIX = "sk_proj_";

/** Generate a fresh opaque token: prefix + 32 random bytes as URL-safe base64. */
export function generateApiTokenValue(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** SHA-256 hex hash of a token, as stored at rest. */
export function hashApiToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time comparison of two token hashes. */
export function apiTokenHashEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
