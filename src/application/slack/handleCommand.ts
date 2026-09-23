import type { SlackCommand } from "@/application/slack/engagement";
import type { SlackEventDeps } from "@/application/slack/types";
import { log } from "@/shared/logger";

/**
 * The fixed actions a message can be, instead of a question for the agent.
 *
 * They are answered here rather than by a run for two reasons. A run costs a
 * model call and the answer is a constant. The mute commands change *whether
 * the bot speaks again*, which no amount of prompting makes reliable — a person
 * silencing a thread has to be obeyed, not interpreted.
 */

/** What one command needs to know about where it was sent. */
export interface CommandContext {
  projectName: string;
  botToken: string;
  channel: string;
  /** The thread the reply goes in — the message's own ts when it started one. */
  threadTs: string;
  eventTs: string;
  /**
   * Whether the message was written *inside* a thread.
   *
   * `threadTs` cannot answer this: a top-level message's reply opens a thread
   * rooted at itself, so the two are equal there. Muting a thread nobody has
   * replied in yet would silence a conversation before it existed, which is why
   * this is asked separately.
   */
  inThread: boolean;
  /**
   * A DM, where muting has no meaning: the gate answers every message in one
   * without consulting engagement at all, so a mute would be recorded and then
   * ignored. Saying so beats confirming something that is not true.
   */
  assistantThread: boolean;
}

const HELP = [
  "*Commands*",
  "`!help` — this list",
  "`!stop` — stop the current run in this thread",
  "`!mute` — stop replying in this thread without a mention",
  "`!unmute` — start again",
  "",
  "A command has to stand alone. Anything else is an ordinary request.",
  "Mentioning me directly always works, muted or not.",
].join("\n");

/**
 * Muting is per thread, so this is what a top-level `!mute` gets instead of
 * silence — the command is not wrong, it is in the wrong place, and saying so
 * is the difference between a hint and a bot that ignored you.
 */
const MUTE_NEEDS_A_THREAD =
  ":mute: Muting works per thread — reply `!mute` (or `!unmute`) inside the thread you mean.";

/**
 * A DM answers every message by definition, so there is nothing engagement
 * could be muted *from*. Recording one anyway would leave a flag nothing reads
 * and a confirmation that was never true.
 */
const MUTE_IS_FOR_CHANNELS =
  ":mute: Muting applies to channel threads. Here, every message reaches me — close the conversation instead.";

export async function handleSlackCommand(
  deps: SlackEventDeps,
  command: SlackCommand,
  ctx: CommandContext,
): Promise<void> {
  const say = async (text: string): Promise<void> => {
    await deps.slack
      .postMessage(ctx.botToken, { channel: ctx.channel, thread_ts: ctx.threadTs, text })
      .catch((error) => log.error("slack", `command ${command} could not reply`, error));
  };

  log.info("slack", `command ${command} project=${ctx.projectName} channel=${ctx.channel}`);

  if (command === "help") {
    await say(HELP);
    return;
  }
  if (command === "stop") {
    if (!ctx.inThread) {
      await say("Reply `!stop` inside the thread you want to stop, or use its stop button.");
      return;
    }
    try {
      await deps.stops.requestStop(ctx, ctx.eventTs);
    } catch (error) {
      log.error("slack", "stop request could not be recorded", error);
      await say(":warning: I could not stop this run. Please try again.");
      return;
    }
    await say("Stop requested for this thread.");
    return;
  }
  if (ctx.assistantThread) {
    await say(MUTE_IS_FOR_CHANNELS);
    return;
  }
  if (!ctx.inThread) {
    await say(MUTE_NEEDS_A_THREAD);
    return;
  }
  const muted = command === "mute";
  try {
    await deps.threads.setMuted(ctx.projectName, ctx.channel, ctx.threadTs, muted);
  } catch (error) {
    log.error("slack", `command ${command} could not be recorded`, error);
    // Said out loud rather than swallowed: the whole point of the command is
    // that the next message is treated differently, and a person who is not
    // told it failed will assume the bot is ignoring them when it answers.
    await say(":warning: I could not save that just now — try again in a moment.");
    return;
  }
  await say(
    muted
      ? "Muted. I won't reply in this thread unless someone mentions me."
      : "Unmuted. I'll follow this thread again.",
  );
}
