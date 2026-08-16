import { createHmac } from "node:crypto";
import { ValidationError } from "@/application/errors";
import {
  actorKey,
  conversationOf,
  MAX_CONVERSATION_ID_LENGTH,
  type RunActor,
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
 * Qualified by who is asking, because the id is theirs — two callers that both
 * send `X-Conversation-Id: 1` are in two conversations, and an MCP server or a
 * remote agent must not be told otherwise. The caller is a **keyed** digest of
 * the actor key rather than the key itself or a plain hash of it: for a person
 * that key is an email, the value travels to every MCP server the run reaches,
 * and an unkeyed hash of an email is a lookup table away from the email. Keyed
 * with this deployment's own secret it is a pseudonym that means something only
 * here — stable across this caller's requests, and nothing outside this
 * deployment can produce or reverse it. A token acts as its owner, so every
 * request made with one project token shares a namespace, which is what a
 * machine caller managing its own ids expects.
 *
 * Absent when the header is: this is the one surface where a conversation is
 * opt-in, and nothing is invented for a caller that declared none. A header
 * that is too long to keep is refused rather than dropped — a caller that
 * declared a conversation and silently ran without one would have no way to
 * know — as a 400 through `ValidationError`, like every other bad input.
 */
export function requestConversation(request: Request, actor: RunActor): RunConversation | null {
  const raw = request.headers.get(CONVERSATION_REQUEST_HEADER);
  if (raw === null || !raw.trim()) {
    return null;
  }
  const caller = createHmac("sha256", config.aesEncryptionKey)
    .update(actorKey(actor))
    .digest("hex")
    .slice(0, CALLER_PREFIX_LENGTH - 1);
  const conversation = conversationOf("api", `${caller}:${raw}`);
  if (!conversation) {
    throw new ValidationError(
      `${CONVERSATION_REQUEST_HEADER} is too long: at most ${MAX_CONVERSATION_ID_LENGTH - CALLER_PREFIX_LENGTH} characters once encoded`,
    );
  }
  return conversation;
}
