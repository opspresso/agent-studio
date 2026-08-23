import { cutCodePoints } from "@/shared/utf8Text";

const MAX_TITLE_LENGTH = 50;

/** Derive a chat title from the first user message, truncated to 50 chars. */
export function titleFromMessage(message: string): string {
  const trimmed = message.trim().replace(/\s+/g, " ");
  if (trimmed.length <= MAX_TITLE_LENGTH) {
    return trimmed || "New chat";
  }
  return `${cutCodePoints(trimmed, MAX_TITLE_LENGTH - 1)}…`;
}
