import type { RemoteConversationRepository } from "@/domain/agent/remoteConversation";
import { deleteItem, getItem, putItem } from "../store";
import { keys } from "../keys";
import { expiresAtFromNow, isExpired, REMOTE_CONVERSATION_TTL_SECONDS } from "../ttl";

/**
 * Which remote conversation an external agent holds for one of ours.
 *
 * An unconditional put, like the Slack engagement row it is modelled on: every
 * transfer restarts the window, and there is nothing to race over — two
 * transfers from one conversation to one agent write the value the remote
 * itself keeps handing back.
 */
export const remoteConversationRepository: RemoteConversationRepository = {
  async get(projectName, agentName, conversationKey) {
    const item = await getItem(keys.remoteConversation(projectName, agentName, conversationKey));
    const contextId = item?.contextId;
    if (typeof contextId !== "string" || !contextId) {
      return null;
    }
    // The sweep is periodic, so an expired row is still readable for a tick.
    // Checked rather than trusted, like engagement.
    if (isExpired(item?.expiresAt, Date.now())) {
      return null;
    }
    const taskId = item?.taskId;
    return { contextId, ...(typeof taskId === "string" && taskId ? { taskId } : {}) };
  },

  async put(projectName, agentName, conversationKey, { contextId, taskId }) {
    await putItem({
      ...keys.remoteConversation(projectName, agentName, conversationKey),
      entityType: "remoteConversation",
      projectName,
      agentName,
      conversationKey,
      contextId,
      ...(taskId ? { taskId } : {}),
      updatedAt: new Date().toISOString(),
      expiresAt: expiresAtFromNow(REMOTE_CONVERSATION_TTL_SECONDS),
    });
  },

  async forget(projectName, agentName, conversationKey) {
    // Unconditional, like the put: deleting a row that is already gone is the
    // outcome wanted, not a conflict.
    await deleteItem(keys.remoteConversation(projectName, agentName, conversationKey));
  },
};
