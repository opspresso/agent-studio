import { createHash } from "node:crypto";
import {
  actorKey,
  conversationOf,
  type RunActor,
  type RunConversation,
} from "@/domain/execution/actor";

/**
 * The header an API caller names its conversation with. Optional: the three
 * execution endpoints have no thread of their own, so continuity is the
 * caller's to declare — and a caller that declares none runs each request as
 * its own conversation, which is what every request was before the header
 * existed.
 */
export const CONVERSATION_REQUEST_HEADER = "X-Conversation-Id";

/**
 * Longest header value read. The domain bounds the id it keeps; this bounds
 * what is *hashed and read at all*, so a caller cannot make the route work on
 * a kilobyte of header before the domain gets to shorten it.
 */
const MAX_HEADER_LENGTH = 512;

/**
 * The conversation an API request belongs to, under the caller:
 * `api:{caller}:{id}`.
 *
 * Qualified by who is asking, because the id is theirs — two callers that both
 * send `X-Conversation-Id: 1` are in two conversations, and an MCP server or a
 * remote agent must not be told otherwise. The caller is a short digest of the
 * actor key rather than the key itself: for a person that key is an email, and
 * this value travels to every MCP server the run reaches. A token acts as its
 * owner, so every request made with one project token shares a namespace,
 * which is what a machine caller managing its own ids expects.
 *
 * Absent when the header is: this is the one surface where a conversation is
 * opt-in, and nothing is invented for a caller that declared none.
 */
export function requestConversation(request: Request, actor: RunActor): RunConversation | null {
  const raw = request.headers.get(CONVERSATION_REQUEST_HEADER);
  if (!raw || raw.length > MAX_HEADER_LENGTH) {
    return null;
  }
  const caller = createHash("sha256").update(actorKey(actor)).digest("hex").slice(0, 16);
  return conversationOf("api", `${caller}:${raw}`);
}
