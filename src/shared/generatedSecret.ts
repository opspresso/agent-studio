import { createHash, randomBytes } from "node:crypto";
import { timingSafeEqualString } from "./timingSafe";

/**
 * Secrets Agent Studio issues itself, as opposed to credentials an operator
 * pastes in from another system.
 *
 * Every one carries a prefix so a leaked string can be traced back to this
 * product and to what it opens, the way `ghp_`/`gho_` do for GitHub: two
 * characters for agent-studio, then one for the kind.
 *
 *   ast_…   agent API token (per agent, owner-managed)
 *   asw_…   webhook trigger secret (per trigger, owner-managed)
 *   asg_…   Telegram webhook secret (per agent; minted here, handed only to Telegram)
 *
 * The random part is 32 bytes — 256 bits — so the prefix costs no entropy that
 * matters. Verification compares hashes and never looks at the prefix, so
 * secrets issued under an older one keep working.
 */

const VENDOR = "as";

export type GeneratedSecretKind =
  | "agentApiToken"
  | "triggerSecret"
  | "telegramWebhookSecret";

const KIND_CHAR: Record<GeneratedSecretKind, string> = {
  agentApiToken: "t",
  triggerSecret: "w",
  telegramWebhookSecret: "g",
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
  return timingSafeEqualString(a, b);
}
