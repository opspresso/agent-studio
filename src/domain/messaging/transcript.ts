/**
 * What a chat-bot surface remembers of a conversation when the platform keeps
 * no history it can read back.
 *
 * Slack hands a thread's replies to anyone with the bot token, so a Slack run
 * assembles its context from the platform. The Telegram Bot API has no such
 * call — a bot sees each update once — so the only way a follow-up can carry
 * the question before it is for this platform to have written both down. That
 * is what this is: a bounded, expiring record of the turns exchanged in one
 * conversation, per agent, kept for context and nothing else. It is not a
 * chat: nobody reads it back in a console, it is not replayed with its tool
 * traffic, and losing it costs the next question its context, not its answer.
 */

/** One turn of a conversation, as the model would read it. */
export interface TranscriptTurn {
  role: "user" | "assistant";
  /** Text only — pictures and files are not kept here; the reply named them. */
  content: string;
  /** The platform's id for the human who wrote it. Absent on the bot's turns. */
  userId?: string;
  /**
   * How that human is named to the model, kept only when the Agent asked to
   * know who is asking (`callerContext`) — the same opt-in that gates the name
   * reaching a prompt gates it being written down.
   */
  speaker?: string;
  /** ISO instant; what orders the turns and what the retention runs from. */
  createdAt: string;
}

export interface ConversationTranscriptRepository {
  /**
   * The newest `limit` turns of one conversation, oldest first — what a run
   * carries as history. Expired rows are not returned.
   */
  recent(agentName: string, conversationKey: string, limit: number): Promise<TranscriptTurn[]>;
  /** Write one turn down. Never throws for a full or slow store's sake — the caller decides that. */
  append(agentName: string, conversationKey: string, turn: TranscriptTurn): Promise<void>;
}
