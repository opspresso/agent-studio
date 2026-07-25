import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Secrets Agent Studio issues itself, as opposed to credentials an operator
 * pastes in from another system.
 *
 * Every one carries a prefix so a leaked string can be traced back to this
 * product and to what it opens, the way `ghp_`/`gho_` do for GitHub: two
 * characters for agent-studio, then one for the kind.
 *
 *   asa_…   A2A API key       (app-wide, admin-managed)
 *   ast_…   project API token (per project, owner-managed)
 *
 * The random part is 32 bytes — 256 bits — so the prefix costs no entropy that
 * matters. Verification compares hashes and never looks at the prefix, so
 * secrets issued under an older one keep working.
 */

const VENDOR = "as";

export type GeneratedSecretKind = "a2aApiKey" | "projectApiToken";

const KIND_CHAR: Record<GeneratedSecretKind, string> = {
  a2aApiKey: "a",
  projectApiToken: "t",
};

/** The `as{kind}_` prefix a generated secret of this kind carries. */
export function secretPrefix(kind: GeneratedSecretKind): string {
  return `${VENDOR}${KIND_CHAR[kind]}_`;
}

/** Generate a fresh opaque secret: prefix + 32 random bytes as URL-safe base64. */
export function generateSecretValue(kind: GeneratedSecretKind): string {
  return `${secretPrefix(kind)}${randomBytes(32).toString("base64url")}`;
}

/** SHA-256 hex hash of a secret, as stored at rest. */
export function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Constant-time comparison of two hashes. */
export function secretHashEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
