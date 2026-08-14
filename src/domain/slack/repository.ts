/**
 * Threads this project's bot is currently part of.
 *
 * A channel does not tell the bot which of its messages are for it, and asking
 * Slack — reading a thread's replies to see whether the bot is in it — costs a
 * rate-limited round trip on every message the workspace produces. So the bot
 * writes down where it spoke, and reads that back instead.
 *
 * The window is what makes this bounded rather than a growing claim on the
 * workspace: engagement is refreshed each time the bot answers and expires on
 * its own, so a thread from last month needs a mention again. The row is a hint,
 * never a record — losing one costs a follow-up its answer, nothing more.
 */
export interface SlackThreadRepository {
  /**
   * Remember that the bot answered in this thread, restarting its window.
   * Called after every channel reply, so an active conversation stays open for
   * as long as it stays active.
   */
  markEngaged(projectName: string, channel: string, threadTs: string): Promise<void>;
  /** Whether the bot answered in this thread and the window has not passed. */
  isEngaged(projectName: string, channel: string, threadTs: string): Promise<boolean>;
}
