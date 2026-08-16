import { conversationOf, type RunActor, type RunConversation } from "@/domain/execution/actor";

/**
 * An inbound A2A conversation is the caller's `contextId`, under the caller:
 * `a2a:{actorId}:{contextId}`.
 *
 * The protocol makes `contextId` the client's grouping of its own messages, so
 * two clients may well mint the same one — a UUID by convention, but nothing
 * checks. Qualifying it by the actor id (`shared-key`, or a named client key)
 * keeps one client's thread from continuing another's. The actor id is never
 * an email on this surface, so nothing personal enters the key.
 */
export function a2aConversation(actor: RunActor, contextId: string): RunConversation | null {
  return conversationOf("a2a", `${actor.id}:${contextId}`);
}
