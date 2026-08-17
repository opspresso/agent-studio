import { createHash, randomBytes } from "node:crypto";
import { timingSafeEqualString } from "./timingSafe";

/**
 * Secrets AgentDure issues itself, as opposed to credentials an operator
 * pastes in from another system.
 *
 * Every one carries a prefix so a leaked string can be traced back to this
 * product and to what it opens, the way `ghp_`/`gho_` do for GitHub: two
 * characters for agentdure, then one for the kind.
 *
 *   ada_…   A2A API key       (app-wide, admin-managed)
 *   adc_…   A2A client key    (per client, admin-managed)
 *   adt_…   project API token (per project, owner-managed)
 *   adw_…   webhook trigger secret (per trigger, owner-managed)
 *   adg_…   Telegram webhook secret (per project; minted here, handed only to Telegram)
 *
 * The random part is 32 bytes — 256 bits — so the prefix costs no entropy that
 * matters. Verification compares hashes and never looks at the prefix, so
 * secrets issued under an older one keep working.
 */

const VENDOR = "ad";

export type GeneratedSecretKind =
  | "a2aApiKey"
  | "a2aClientKey"
  | "projectApiToken"
  | "triggerSecret"
  | "telegramWebhookSecret";

const KIND_CHAR: Record<GeneratedSecretKind, string> = {
  a2aApiKey: "a",
  a2aClientKey: "c",
  projectApiToken: "t",
  triggerSecret: "w",
  telegramWebhookSecret: "g",
};

/** The `ad{kind}_` prefix a generated secret of this kind carries. */
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
