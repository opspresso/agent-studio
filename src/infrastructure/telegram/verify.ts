import { timingSafeEqualString } from "@/shared/timingSafe";

/** The header Telegram echoes the webhook's `secret_token` in, on every delivery. */
export const TELEGRAM_SECRET_HEADER = "x-telegram-bot-api-secret-token";

/**
 * Whether a delivery carries the secret this project's webhook was registered
 * with. Constant-time, like every other secret comparison here; a missing
 * header is simply wrong.
 */
export function verifyTelegramSecret(header: string | null, expected: string): boolean {
  return header !== null && expected !== "" && timingSafeEqualString(header, expected);
}
