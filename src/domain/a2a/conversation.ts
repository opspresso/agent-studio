import { conversationOf, type RunActor, type RunConversation } from "@/domain/execution/actor";

/**
 * An inbound A2A conversation is the caller's `contextId`, under the caller:
 * `a2a:{actorId}:{contextId}`.
 *
 * The protocol makes `contextId` the client's grouping of its own messages, so
 * two clients may well mint the same one — a UUID by convention, but nothing
 * checks. Qualifying it by the actor id keeps a **named client key's** threads
 * apart from every other client's. Under the **shared** key the actor is the
 * constant `shared-key` for everyone, so the qualifier separates nothing there:
 * two callers of the shared key that pick the same `contextId` are one
 * conversation, to a memory server and to a remote agent alike. That is the
 * shared key's standing property — one identity for every machine caller — and
 * the reason a caller that needs its own conversations gets a named key. The
 * actor id is never an email on this surface, so nothing personal enters the
 * key.
 */
export function a2aConversation(actor: RunActor, contextId: string): RunConversation | null {
  return conversationOf("a2a", `${actor.id}:${contextId}`);
}
