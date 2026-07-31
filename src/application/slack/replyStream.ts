import type { SlackClientPort } from "@/application/slack/types";
import { log } from "@/shared/logger";

/**
 * How a Slack reply is delivered — the single owner of that decision.
 *
 * There are two ways to put a growing answer on screen and they are not
 * interchangeable:
 *
 * - **Streaming** (`chat.startStream` → `chat.appendStream` → `chat.stopStream`)
 *   is what the agent surface expects. Slack renders it as text arriving, sends
 *   only deltas, and its append is rate-limited an order of magnitude more
 *   generously than an edit loop.
 * - **Edit in place** (`chat.postMessage` → `chat.update`) is what every
 *   workspace can do. Slack documents no more than one edit per three seconds,
 *   and a reader arriving mid-run sees what looks like a finished answer that
 *   stops mid-sentence — hence the trailing indicator.
 *
 * A caller streams a reply without knowing which of the two it got: the sink
 * opens on the first output, prefers streaming, and falls back on failure.
 */

/** Cadence of `chat.appendStream`, whose limit is Tier 4 (100+/min). */
const STREAM_INTERVAL_MS = 1000;
/** Cadence of `chat.update`. Slack documents at most one edit per three seconds. */
const EDIT_INTERVAL_MS = 3000;
/** Cadence of `assistant.threads.setStatus`; an unchanged status is never re-sent. */
const STATUS_INTERVAL_MS = 1000;
/**
 * Appended to an edited-in-place reply that is still being written, when the
 * deployment names nothing else.
 *
 * A built-in emoji as the default, because it is the only kind that renders
 * everywhere: a custom name a workspace has not defined shows up as its own
 * literal text, which is noise exactly where the reply should read as
 * unfinished-but-fine. A workspace that *has* one says so through
 * `SLACK_LOADING_INDICATOR`. A streamed reply needs none — Slack marks it as
 * still arriving itself.
 */
export const DEFAULT_LOADING_INDICATOR = ":hourglass_flowing_sand:";

/** Where a reply goes, and what that surface supports. */
export interface ReplyTarget {
  channel: string;
  threadTs: string;
  /**
   * A DM or agent-container thread, where Slack renders a native status line.
   * A channel thread has none, so status calls are skipped rather than failed.
   */
  assistantThread: boolean;
  /** Required by Slack to stream into a channel; absent in a DM. */
  recipient?: { userId: string; teamId: string };
}

export interface ReplySink {
  /** Native progress line. Throttled, deduplicated, and never fatal. */
  status(text: string): Promise<void>;
  /** The answer *so far*. The sink works out what still needs sending. */
  push(fullText: string): Promise<void>;
  /** Deliver whatever is left, plus any warnings, and clear the status. */
  finish(fullText: string, suffix: string): Promise<void>;
}

function withSuffix(text: string, suffix: string): string {
  if (!suffix) {
    return text;
  }
  return text ? `${text}\n\n${suffix}` : suffix;
}

export function createReplySink(
  slack: SlackClientPort,
  token: string,
  target: ReplyTarget,
  loadingIndicator?: string,
): ReplySink {
  let mode: "unopened" | "stream" | "edit" = "unopened";
  let messageTs = "";
  let messageChannel = target.channel;
  /**
   * How much of the answer Slack has. Only advanced on a *successful* write, so
   * a dropped append is re-sent with the next one instead of being lost: the
   * edit path re-sends the whole answer every time and heals itself, but a
   * stream sends each delta exactly once.
   */
  let flushed = 0;
  let lastWrite = 0;
  let lastStatus = "";
  let lastStatusAt = 0;
  const indicator = loadingIndicator || DEFAULT_LOADING_INDICATOR;

  async function open(text: string): Promise<void> {
    try {
      const started = await slack.startStream(token, {
        channel: target.channel,
        thread_ts: target.threadTs,
        ...(target.recipient
          ? {
              recipient_user_id: target.recipient.userId,
              recipient_team_id: target.recipient.teamId,
            }
          : {}),
      });
      mode = "stream";
      messageTs = started.ts;
      messageChannel = started.channel || target.channel;
      return;
    } catch (error) {
      // Not every workspace or plan can stream. This is the expected path there,
      // so it is a warning about a downgrade, not a failed reply.
      log.warn(
        "slack",
        `streaming unavailable, editing in place instead: ${
          error instanceof Error ? error.message : "unknown"
        }`,
      );
    }
    const posted = await slack.postMessage(token, {
      channel: target.channel,
      thread_ts: target.threadTs,
      text: `${text} ${indicator}`,
    });
    mode = "edit";
    messageTs = posted.ts;
    messageChannel = posted.channel || target.channel;
    flushed = text.length;
  }

  async function sendStatus(text: string): Promise<void> {
    if (!target.assistantThread || text === lastStatus) {
      return;
    }
    const now = Date.now();
    // An explicit clear always goes out; only progress text is paced.
    if (text !== "" && now - lastStatusAt < STATUS_INTERVAL_MS) {
      return;
    }
    lastStatus = text;
    lastStatusAt = now;
    await slack
      .setStatus(token, {
        channel_id: target.channel,
        thread_ts: target.threadTs,
        status: text,
      })
      .catch(() => {});
  }

  return {
    status: sendStatus,

    async push(fullText) {
      if (fullText.length <= flushed) {
        return;
      }
      if (mode === "unopened") {
        // No pacing on the first write: the point of it is that something shows
        // up quickly. A failure here leaves the sink unopened, so the next push
        // retries with everything that has accumulated since.
        await open(fullText).catch((error) => {
          log.error("slack", "reply could not be opened", error);
        });
        if (mode === "unopened") {
          return;
        }
        lastWrite = Date.now();
        if (mode === "stream") {
          // `chat.startStream` opened the message empty, so the first append
          // carries everything accumulated so far.
          await slack
            .appendStream(token, {
              channel: messageChannel,
              ts: messageTs,
              markdown_text: fullText,
            })
            .then(() => {
              flushed = fullText.length;
            })
            .catch(() => {});
        }
        return;
      }
      const now = Date.now();
      if (now - lastWrite < (mode === "stream" ? STREAM_INTERVAL_MS : EDIT_INTERVAL_MS)) {
        return;
      }
      lastWrite = now;
      if (mode === "stream") {
        await slack
          .appendStream(token, {
            channel: messageChannel,
            ts: messageTs,
            markdown_text: fullText.slice(flushed),
          })
          .then(() => {
            flushed = fullText.length;
          })
          .catch(() => {});
        return;
      }
      await slack
        .updateMessage(token, {
          channel: messageChannel,
          ts: messageTs,
          text: `${fullText} ${indicator}`,
        })
        .then(() => {
          flushed = fullText.length;
        })
        .catch(() => {});
    },

    async finish(fullText, suffix) {
      // Warnings ride out with the answer rather than replacing it: a late
      // failure (image upload, timeout, mid-stream error) must not discard text
      // that already reached the user.
      try {
        if (mode === "unopened") {
          await slack.postMessage(token, {
            channel: target.channel,
            thread_ts: target.threadTs,
            text: withSuffix(fullText, suffix) || "(no response)",
          });
        } else if (mode === "stream") {
          const remaining = withSuffix(fullText.slice(flushed), suffix);
          await slack.stopStream(token, {
            channel: messageChannel,
            ts: messageTs,
            ...(remaining ? { markdown_text: remaining } : {}),
          });
          flushed = fullText.length;
        } else {
          await slack.updateMessage(token, {
            channel: messageChannel,
            ts: messageTs,
            text: withSuffix(fullText, suffix) || "(no response)",
          });
          flushed = fullText.length;
        }
      } catch (error) {
        log.error("slack", "final reply write failed", error);
      }
      // Sending a message clears the status on its own, but only if the send
      // above succeeded — clear it explicitly so a failed reply does not leave
      // the thread claiming to still be working.
      await sendStatus("");
    },
  };
}
