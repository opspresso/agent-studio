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
/**
 * What is remembered: the remote's `contextId`, and — when the remote stopped
 * to ask for input — the task that question belongs to, so the next transfer
 * answers it instead of opening a new task beside it.
 */
export interface RemoteConversationHint {
  contextId: string;
  taskId?: string;
}

export interface RemoteConversationRepository {
  /** The hint last seen for this triple, if any and not expired. */
  get(projectName: string, agentName: string, conversationKey: string): Promise<RemoteConversationHint | null>;
  /**
   * Remember the remote's `contextId` (and a task waiting for input) for this
   * triple, restarting its window. Called after every reply that named one,
   * so a live conversation stays continuable for as long as it stays live.
   */
  put(
    projectName: string,
    agentName: string,
    conversationKey: string,
    hint: RemoteConversationHint,
  ): Promise<void>;
  /**
   * Drop the remembered `contextId` for this triple, so the next transfer
   * starts cold. Called when a transfer that *continued* a context failed: the
   * remote may have retired the context (a week here is longer than some keep
   * one), and a wrong hint that is kept costs every transfer until it expires,
   * where a hint dropped costs one cold start.
   */
  forget(projectName: string, agentName: string, conversationKey: string): Promise<void>;
}
