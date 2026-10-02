import { createHmac } from "node:crypto";
import { ValidationError } from "@/application/errors";
import {
  conversationOf,
  MAX_CONVERSATION_ID_LENGTH,
  type RunConversation,
} from "@/domain/execution/actor";
import { config } from "@/lib/config";

/**
 * The header an API caller names its conversation with. Optional: the three
 * execution endpoints have no thread of their own, so continuity is the
 * caller's to declare — and a caller that declares none runs each request as
 * its own conversation, which is what every request was before the header
 * existed.
 */
export const CONVERSATION_REQUEST_HEADER = "X-Conversation-Id";

/** `{digest}:` — what the caller's namespace costs out of the domain's bound. */
const CALLER_PREFIX_LENGTH = 17;

/**
 * The conversation an API request belongs to, under the caller:
 * `api:{caller}:{id}`.
 *
 * The keyed digest uses the authenticated Studio user ID. Email changes and
 * token rotation preserve the namespace; a different account never inherits it.
 * The deployment secret keeps the internal user ID out of MCP conversation keys.
 *
 * Absent when the header is: this is the one surface where a conversation is
 * opt-in, and nothing is invented for a caller that declared none. A header
 * that is too long to keep is refused rather than dropped — a caller that
 * declared a conversation and silently ran without one would have no way to
 * know — as a 400 through `ValidationError`, like every other bad input.
 */
export function requestConversation(request: Request, userId: string): RunConversation | null {
  const raw = request.headers.get(CONVERSATION_REQUEST_HEADER);
  if (raw === null || !raw.trim()) {
    return null;
  }
  if (!userId) throw new ValidationError("An authenticated API caller is required for a conversation");
  const conversation = conversationOf("api", `${callerPrefix(userId)}:${raw}`);
  if (!conversation) {
    throw new ValidationError(
      `${CONVERSATION_REQUEST_HEADER} is too long: at most ${MAX_CONVERSATION_ID_LENGTH - CALLER_PREFIX_LENGTH} characters once encoded`,
    );
  }
  return conversation;
}

/** The keyed digest that stands in for the caller in a conversation key. */
function callerPrefix(userId: string): string {
  return createHmac("sha256", config.aesEncryptionKey)
    .update(userId)
    .digest("hex")
    .slice(0, CALLER_PREFIX_LENGTH - 1);
}
