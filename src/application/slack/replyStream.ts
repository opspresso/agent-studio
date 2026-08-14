import type { SlackChunk, SlackClientPort } from "@/application/slack/types";
import { log } from "@/shared/logger";
import { unrefTimer } from "@/shared/unrefTimer";

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
 *
 * **Progress is one report with two renderings, not a DM feature with a channel
 * imitation.** A run says what it is doing; each surface shows that its own way:
 *
 * - an agent thread (`assistantThread`) has Slack's native status line
 *   (`assistant.threads.setStatus`), which Slack animates and expires;
 * - a channel has the stream's **task axis** — a `task_update` chunk, which
 *   Slack renders and animates in the same message the answer streams into.
 *
 * Modelling status as *the DM mechanism* is what used to cost the channel both.
 * The only thing left to imitate it with was text, text had to go in the reply,
 * and a note in the reply could not be replaced by what it stood in for
 * (`appendStream` only ever adds) — so every channel run that reported progress
 * was pushed onto edit-in-place and gave up streaming: no native rendering, and
 * one edit per three seconds instead of a hundred appends a minute. The two
 * axes are independent, so none of that is true any more.
 *
 * The text note survives as the fallback for a workspace that cannot stream at
 * all, which is the only place it was ever the *right* answer.
 */

/** Cadence of `chat.appendStream`, whose limit is Tier 4 (100+/min). */
const STREAM_INTERVAL_MS = 1000;
/** Cadence of `chat.update`. Slack documents at most one edit per three seconds. */
const EDIT_INTERVAL_MS = 3000;
/**
 * How old a status may get before it is sent again unchanged.
 *
 * Slack expires a status two minutes after it is set, and a run may take longer
 * — so a status set once and never repeated disappears while the agent is still
 * working, which reads as an agent that died. Well inside that window, so even a
 * missed heartbeat tick still lands before the expiry.
 */
const STATUS_REFRESH_MS = 45_000;
/**
 * The id the run's ambient state is sent under — "is thinking…", before any
 * step of its own exists. Constant, so re-sending it retitles that one row
 * rather than adding another.
 *
 * Every *step* carries its own id instead, which is what makes the channel show
 * a checklist that accumulates. The two are different things: the ambient line
 * is the run having nothing more specific to say, and a step is a unit of work
 * with a real beginning and end.
 */
const AMBIENT_TASK_ID = "run-progress";
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
   * A channel has none — it reports progress on the stream's task axis instead,
   * which is why this decides the *mechanism* rather than whether to report.
   */
  assistantThread: boolean;
  /** Required by Slack to stream into a channel; absent in a DM. */
  recipient?: { userId: string; teamId: string };
}

export interface ReplySink {
  /**
   * What the run is doing now. Throttled and never fatal.
   *
   * The caller says it once; the sink picks the rendering the surface has —
   * the agent thread's status line, or a task on the channel's stream.
   * `loadingMessages` are rotated by Slack under the status line (at most ten)
   * and mean nothing to the task axis, which animates on its own.
   */
  status(text: string, loadingMessages?: string[]): Promise<void>;
  /**
   * A unit of work began — a tool call, a hand-off — identified by something
   * stable for its lifetime.
   *
   * Where the surface renders a checklist this adds a row; where it renders one
   * status line it takes the line over. Calling it again with the same `id`
   * retitles that step rather than adding a second.
   */
  step(id: string, title: string): Promise<void>;
  /**
   * That unit of work finished. `title` replaces the one it opened with when the
   * ending says more than the beginning did — a tool result names what it acted
   * on, which the call alone does not.
   *
   * Only a real boundary may call this. Nothing else in a run has one: a status
   * line changing does not mean the last thing it said is *finished*, and a
   * checklist that ticked items off on that basis would claim the run completed
   * things it merely stopped mentioning.
   */
  stepDone(id: string, title?: string): Promise<void>;
  /**
   * Keep the current status from expiring while a run is in flight. Returns the
   * stopper; call it in a `finally` so a failed run does not leave a timer.
   */
  keepStatusAlive(): () => void;
  /** The answer *so far*. The sink works out what still needs sending. */
  push(fullText: string): Promise<void>;
  /** Deliver whatever is left, plus any warnings, and clear the status. */
  finish(fullText: string, suffix: string): Promise<void>;
}

/**
 * A status-line phrase, dressed to stand on its own as a message. Slack renders
 * these after the app's name ("AgentDure is thinking…"); posted into a thread
 * they arrive without that subject, so the emphasis is what says this is the
 * app reporting on itself rather than the answer beginning.
 */
function progressText(text: string, indicator: string): string {
  return `_${text}_ ${indicator}`;
}

/**
 * A step, said as a sentence.
 *
 * A checklist row stands on its own and reads best as the bare thing — `Skill:
 * deep-research` — while the two surfaces that render progress as *prose* need
 * a verb: Slack puts the status line after the app's name ("AgentDure is using
 * search…"), and the text-note fallback posts it as a message. One phrasing for
 * both, so the fallback cannot drift from the line it stands in for.
 */
function usingPhrase(title: string): string {
  return `is using ${title}…`;
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
  /**
   * Whether the open message is still only a progress note. It stands in for an
   * answer rather than being one, so a run that ends with no text takes it back
   * instead of leaving it on screen.
   */
  let progressOnly = false;
  let lastWrite = 0;
  let lastStatus = "";
  let lastStatusLoading: string[] | undefined;
  let lastStatusAt = 0;
  /**
   * The checklist, in the order Slack was told about it. Titles are kept because
   * a `task_update` carries the whole row every time — completing a step means
   * re-sending its title, not sending a status on its own.
   */
  const steps = new Map<string, { title: string; complete: boolean }>();
  /**
   * Whether the ambient "is thinking…" row has been closed off.
   *
   * It is closed by the first *step*, because that is the moment the run stopped
   * deciding and started doing. Leaving it open would put a permanently spinning
   * row above a checklist that is visibly moving.
   */
  let ambientClosed = false;
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
        // Only where tasks are the status mechanism. An agent thread has the
        // native line instead and sends none, and declaring a layout for
        // tasks that never arrive describes the message wrongly.
        ...(target.assistantThread ? {} : { task_display_mode: "timeline" as const }),
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

  /**
   * Progress on the stream's task axis — what a channel has instead of the
   * agent container's status line.
   *
   * One row per `id`, so the caller decides whether this is a checklist or a
   * single line that keeps being rewritten. Both are here: the ambient state is
   * one constant id, and each step of real work carries its own.
   *
   * The constraint that shapes it: a row may only be ticked off at a *real*
   * boundary. `status` has none — a line changing means the run stopped saying
   * something, not that it finished it — so the ambient row is only ever closed
   * by the first step or by {@link finish}. A tool result does have one, which
   * is why steps can tick off as the run goes.
   *
   * Nothing is written into the reply's own text, which is the whole point —
   * the answer keeps streaming into the same message.
   */
  async function showTask(
    id: string,
    text: string,
    status: "in_progress" | "complete",
    /** What the text-note fallback writes instead, when a row's wording is not a sentence. */
    prose = text,
  ): Promise<void> {
    const chunk = { type: "task_update" as const, id, title: text, status };
    if (mode === "stream") {
      await slack
        .appendStream(token, { channel: messageChannel, ts: messageTs, chunks: [chunk] })
        // Remembered only once Slack has it, so a dropped append is retried by
        // the next status rather than swallowed by the no-repeat guard.
        .then(() => {
          lastStatus = text;
        })
        .catch(() => {});
      return;
    }
    // Nothing open yet: the task is what opens the message, so a run that
    // spends minutes in tools before its first token is not a silent bot.
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
        task_display_mode: "timeline",
        chunks: [chunk],
      });
      mode = "stream";
      progressOnly = true;
      messageTs = started.ts;
      messageChannel = started.channel || target.channel;
      lastStatus = text;
    } catch (error) {
      // The workspace or plan cannot stream. Fall back to the note in text,
      // which is what this surface had before tasks existed.
      log.warn(
        "slack",
        `task progress unavailable, posting a note instead: ${
          error instanceof Error ? error.message : "unknown"
        }`,
      );
      await showProgress(prose);
    }
  }

  /**
   * Progress as text, for a channel thread that cannot stream.
   *
   * Paced like any other edit, and never fatal: a failed post leaves the sink
   * unopened so the next call — a status or the answer itself — retries.
   */
  async function showProgress(text: string): Promise<void> {
    // The clear at the end of a run has nothing to say here, and once the answer
    // has started arriving the message belongs to it. Rewriting the message with
    // what it already says costs a call and shows the reader nothing — the same
    // reason the status line above does not repeat itself, except that here the
    // message does not expire, so an unchanged one is never worth re-sending.
    if (!text || flushed > 0 || text === lastStatus) {
      return;
    }
    if (mode === "unopened") {
      try {
        const posted = await slack.postMessage(token, {
          channel: target.channel,
          thread_ts: target.threadTs,
          text: progressText(text, indicator),
        });
        mode = "edit";
        progressOnly = true;
        messageTs = posted.ts;
        messageChannel = posted.channel || target.channel;
        lastWrite = Date.now();
        lastStatus = text;
      } catch (error) {
        log.warn("slack", "progress note could not be posted", error);
      }
      return;
    }
    if (!progressOnly) {
      return;
    }
    const now = Date.now();
    // A progress line the edit limit swallowed is simply skipped: the next tool
    // will write the current one, and nothing here is worth queueing.
    if (now - lastWrite < EDIT_INTERVAL_MS) {
      return;
    }
    lastWrite = now;
    await slack
      .updateMessage(token, {
        channel: messageChannel,
        ts: messageTs,
        text: progressText(text, indicator),
      })
      .then(() => {
        lastStatus = text;
      })
      .catch(() => {});
  }

  async function sendStatus(text: string, loadingMessages?: string[]): Promise<void> {
    if (!target.assistantThread) {
      // The same report, rendered the way this surface renders one. Skipped when
      // there is nothing to say or the answer has taken the message over — a
      // task does not expire, so an unchanged one is never worth re-sending.
      // Once a step exists the checklist is the report, and an ambient line
      // under it would be a second, vaguer account of the same run.
      if (text && flushed === 0 && text !== lastStatus && !ambientClosed) {
        // `lastStatus` is set by whichever mechanism actually lands it — setting
        // it here would make the text-note fallback believe the note it is about
        // to write is already on screen, and it would write nothing at all.
        await showTask(AMBIENT_TASK_ID, text, "in_progress");
      }
      return;
    }
    const now = Date.now();
    // Repeating a status is only worth a call when Slack is about to drop it;
    // nothing to keep alive once it has been cleared. A *changed* status is
    // always sent — it is the whole point of the line, and a paced version of
    // this dropped the second of two tool names and then left the first one on
    // screen for the rest of the run. Nothing else paces it: `setStatus` allows
    // 600/min, one call per distinct text, and each is awaited inside the chunk
    // loop, so the round trip is already the limit.
    if (text === lastStatus && (text === "" || now - lastStatusAt < STATUS_REFRESH_MS)) {
      return;
    }
    lastStatus = text;
    lastStatusLoading = loadingMessages;
    lastStatusAt = now;
    await slack
      .setStatus(token, {
        channel_id: target.channel,
        thread_ts: target.threadTs,
        status: text,
        ...(loadingMessages && loadingMessages.length > 0
          ? { loading_messages: loadingMessages }
          : {}),
      })
      .catch(() => {});
  }

  /**
   * Close the ambient row, once, when the work becomes specific enough to list.
   * On the agent thread there is no list and nothing to close.
   */
  async function closeAmbient(): Promise<void> {
    if (ambientClosed || target.assistantThread || !lastStatus) {
      ambientClosed = true;
      return;
    }
    ambientClosed = true;
    await showTask(AMBIENT_TASK_ID, lastStatus, "complete");
  }

  return {
    status: sendStatus,

    async step(id, title) {
      if (target.assistantThread) {
        // One line, so a step *is* the status — and it has to read as one. The
        // phrasing belongs to the surface rather than to the caller that named
        // the step, which is why a checklist row keeps the bare title.
        await sendStatus(usingPhrase(title));
        return;
      }
      const known = steps.get(id);
      if (known?.title === title && !known.complete) {
        return;
      }
      await closeAmbient();
      steps.set(id, { title, complete: false });
      await showTask(id, title, "in_progress", usingPhrase(title));
    },

    async stepDone(id, title) {
      const known = steps.get(id);
      if (target.assistantThread) {
        // Nothing to mark: the next step takes the line, and `finish` clears it.
        return;
      }
      // A completion for a step that was never opened is the shape of a bug
      // upstream, not something to render — an unopened id would appear as a
      // finished row for work nobody watched start.
      if (!known || known.complete) {
        return;
      }
      const shown = title || known.title;
      steps.set(id, { title: shown, complete: true });
      await showTask(id, shown, "complete");
    },

    keepStatusAlive() {
      if (!target.assistantThread) {
        return () => {};
      }
      const timer = setInterval(() => {
        void sendStatus(lastStatus, lastStatusLoading);
      }, STATUS_REFRESH_MS);
      // A pending refresh must never be what keeps the process alive.
      unrefTimer(timer);
      return () => clearInterval(timer);
    },

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
          progressOnly = false;
        })
        .catch(() => {});
    },

    async finish(fullText, suffix) {
      // Built before the writes below, because two of the three branches never
      // reach the stream close: the checklist is only a channel's, and only a
      // streamed one's.
      const closingChunks: SlackChunk[] = target.assistantThread
        ? []
        : [
            ...(ambientClosed || !lastStatus
              ? []
              : [
                  {
                    type: "task_update" as const,
                    id: AMBIENT_TASK_ID,
                    title: lastStatus,
                    status: "complete" as const,
                  },
                ]),
            ...[...steps.entries()]
              .filter(([, step]) => !step.complete)
              .map(([id, step]) => ({
                type: "task_update" as const,
                id,
                title: step.title,
                status: "complete" as const,
              })),
          ];
      // Warnings ride out with the answer rather than replacing it: a late
      // failure (image upload, timeout, mid-stream error) must not discard text
      // that already reached the user.
      try {
        if (mode === "unopened") {
          const text = withSuffix(fullText, suffix);
          // Nothing was ever opened and there is nothing to say. The sink used
          // to invent a "(no response)" line here, which is how a run that
          // answered purely with an uploaded image ended up captioned as having
          // said nothing — it cannot see what else the run delivered. Whoever
          // knows that decides, and says so as a warning.
          if (text) {
            await slack.postMessage(token, {
              channel: target.channel,
              thread_ts: target.threadTs,
              text,
            });
          }
        } else if (progressOnly && !withSuffix(fullText, suffix)) {
          // Same decision as the branch above, reached from the other side: the
          // only thing on screen is a note standing in for an answer that never
          // came as text. Leaving it would caption a picture-only run as still
          // working, so it is taken back instead. A stream is closed first —
          // deleting a message Slack still considers open leaves it mid-write.
          if (mode === "stream") {
            await slack.stopStream(token, { channel: messageChannel, ts: messageTs }).catch(() => {});
          }
          await slack.deleteMessage(token, { channel: messageChannel, ts: messageTs });
        } else if (mode === "stream") {
          const remaining = withSuffix(fullText.slice(flushed), suffix);
          await slack.stopStream(token, {
            channel: messageChannel,
            ts: messageTs,
            ...(remaining ? { markdown_text: remaining } : {}),
            // Every unfinished row rides out on the close rather than in its own
            // append: a step left `in_progress` on a finished message reads as a
            // run that never came back. The ambient row is one of them when no
            // step ever replaced it.
            ...(closingChunks.length > 0 ? { chunks: closingChunks } : {}),
          });
          flushed = fullText.length;
        } else {
          // An opened message must not be left holding the loading indicator,
          // so unlike the unopened case this always writes something.
          await slack.updateMessage(token, {
            channel: messageChannel,
            ts: messageTs,
            text: withSuffix(fullText, suffix) || "_(no answer)_",
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
