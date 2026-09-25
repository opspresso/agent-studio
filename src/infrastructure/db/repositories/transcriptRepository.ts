import { randomUUID } from "node:crypto";
import type {
  ConversationTranscriptRepository,
  TranscriptTurn,
} from "@/domain/messaging/transcript";
import { queryItems } from "../store";
import { keys } from "../keys";
import { putAgentItem } from "../agentLifecycle";
import { expiresAtFromNow, TRANSCRIPT_TTL_SECONDS } from "../ttl";
import { boundedPageLimit } from "@/shared/pageLimit";

/**
 * A conversation's turns, one row each, in the agent's partition under a
 * sort-key prefix that names the conversation.
 *
 * The sort key is the turn's instant plus a random suffix: two turns can land
 * in the same millisecond (a user turn and the reply that answers it are
 * written a run apart, but two people in one group are not), and a collision
 * would overwrite one with the other. The suffix keeps them distinct; the
 * instant keeps them ordered.
 */
export const transcriptRepository: ConversationTranscriptRepository = {
  async append(agentName, conversationKey, turn) {
    const seq = randomUUID().slice(0, 8);
    await putAgentItem(agentName, {
      ...keys.transcriptTurn(agentName, conversationKey, turn.createdAt, seq),
      entityType: "transcriptTurn",
      agentName,
      conversationKey,
      role: turn.role,
      content: turn.content,
      ...(turn.userId ? { userId: turn.userId } : {}),
      ...(turn.speaker ? { speaker: turn.speaker } : {}),
      createdAt: turn.createdAt,
      expiresAt: expiresAtFromNow(TRANSCRIPT_TTL_SECONDS),
    });
  },

  async recent(agentName, conversationKey, limit) {
    const pageLimit = boundedPageLimit(limit);
    const prefix = keys.transcriptTurnPrefix(agentName, conversationKey);
    // Newest first, bounded, with expired rows left out before the bound
    // counts — the sweep is periodic.
    const items = await queryItems({
      pk: prefix.PK,
      sk: { prefix: prefix.prefix },
      forward: false,
      limit: pageLimit,
      notExpiredAt: Math.floor(Date.now() / 1000),
    });
    // Oldest first: that is the order a history is read in.
    return items.map(fromItem).reverse();
  },
};

function fromItem(item: Record<string, unknown>): TranscriptTurn {
  return {
    role: item.role as TranscriptTurn["role"],
    content: item.content as string,
    ...(typeof item.userId === "string" ? { userId: item.userId } : {}),
    ...(typeof item.speaker === "string" ? { speaker: item.speaker } : {}),
    createdAt: item.createdAt as string,
  };
}
