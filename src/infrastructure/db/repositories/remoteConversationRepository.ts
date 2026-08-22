import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { RemoteConversationRepository } from "@/domain/agent/remoteConversation";
import { getDocumentClient, getTableName } from "../client";
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
    const result = await getDocumentClient().send(
      new GetCommand({
        TableName: getTableName(),
        Key: keys.remoteConversation(projectName, agentName, conversationKey),
      }),
    );
    const contextId = result.Item?.contextId;
    if (typeof contextId !== "string" || !contextId) {
      return null;
    }
    // The physical purge lags the TTL by up to ~48h, so an expired row is still
    // readable. Checked rather than trusted, like engagement.
    if (isExpired(result.Item?.expiresAt, Date.now())) {
      return null;
    }
    const taskId = result.Item?.taskId;
    return { contextId, ...(typeof taskId === "string" && taskId ? { taskId } : {}) };
  },

  async put(projectName, agentName, conversationKey, { contextId, taskId }) {
    await getDocumentClient().send(
      new PutCommand({
        TableName: getTableName(),
        Item: {
          ...keys.remoteConversation(projectName, agentName, conversationKey),
          entityType: "remoteConversation",
          projectName,
          agentName,
          conversationKey,
          contextId,
          ...(taskId ? { taskId } : {}),
          updatedAt: new Date().toISOString(),
          // TTL attribute; enable table TTL on `expiresAt` to purge old rows.
          expiresAt: expiresAtFromNow(REMOTE_CONVERSATION_TTL_SECONDS),
        },
      }),
    );
  },

  async forget(projectName, agentName, conversationKey) {
    // Unconditional, like the put: deleting a row that is already gone is the
    // outcome wanted, not a conflict.
    await getDocumentClient().send(
      new DeleteCommand({
        TableName: getTableName(),
        Key: keys.remoteConversation(projectName, agentName, conversationKey),
      }),
    );
  },
};
