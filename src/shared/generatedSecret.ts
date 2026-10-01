import { randomBytes } from "node:crypto";

/**
 * Secrets Agent Studio issues itself, as opposed to credentials an operator
 * pastes in from another system.
 *
 * Every one carries a prefix so a leaked string can be traced back to this
 * product and to what it opens, the way `ghp_`/`gho_` do for GitHub: two
 * characters for agent-studio, then one for the kind.
 *
 *   ast_…   personal API secret (bound to user and agent)
 *   asw_…   personal Webhook token (bound to user and agent)
 *   asg_…   Telegram webhook secret (per agent; minted here, handed only to Telegram)
 *
 * The random part is 32 bytes — 256 bits — so the prefix costs no entropy that
 * matters. Verification compares full values, never just the prefix.
 */

const VENDOR = "as";

export type GeneratedSecretKind =
  | "agentApiToken"
  | "agentWebhookToken"
  | "telegramWebhookSecret"
  | "messagingLinkCode";

const KIND_CHAR: Record<GeneratedSecretKind, string> = {
  agentApiToken: "t",
  agentWebhookToken: "w",
  telegramWebhookSecret: "g",
  messagingLinkCode: "l",
};

/** The `as{kind}_` prefix a generated secret of this kind carries. */
export function secretPrefix(kind: GeneratedSecretKind): string {
  return `${VENDOR}${KIND_CHAR[kind]}_`;
}

/** Generate a fresh opaque secret: prefix + 32 random bytes as URL-safe base64. */
export function generateSecretValue(kind: GeneratedSecretKind): string {
  return `${secretPrefix(kind)}${randomBytes(32).toString("base64url")}`;
}
