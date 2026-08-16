/**
 * Which remote conversation an external agent holds for one of ours.
 *
 * A2A continues a conversation by `contextId`: the remote mints one on the
 * first message and expects it back on the next. Without this a transfer sent
 * every message as a new conversation, so a second question from the same
 * Slack thread arrived at the remote agent cold — the gap MILESTONES carried
 * until the run knew which conversation it was in (`RunOrigin.conversation`).
 *
 * Keyed by the *transferring* project, the agent's registry name and our own
 * conversation key. The project is part of it on purpose: two projects' bots
 * answering in one Slack thread are two different callers of the remote agent,
 * and folding them into one remote context would show each the other's turns.
 *
 * A hint, never a record — the row expires on its own, and losing one costs
 * the next transfer a cold start, which is exactly what every transfer got
 * before this existed.
 */
export interface RemoteConversationRepository {
  /** The remote `contextId` last seen for this triple, if any and not expired. */
  get(projectName: string, agentName: string, conversationKey: string): Promise<string | null>;
  /**
   * Remember the remote's `contextId` for this triple, restarting its window.
   * Called after every successful transfer, so a live conversation stays
   * continuable for as long as it stays live.
   */
  put(
    projectName: string,
    agentName: string,
    conversationKey: string,
    contextId: string,
  ): Promise<void>;
}
