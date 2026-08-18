import type { ReplySink } from "@/domain/messaging/reply";
import { log, type LogScope } from "@/shared/logger";
import { cutPoint } from "@/shared/messageCut";
import { unrefTimer } from "@/shared/unrefTimer";

/**
 * A reply delivered by sending a message and editing it — the shape every
 * chat platform without a streaming call shares (Telegram, Teams), owned once.
 *
 * What is common is the bookkeeping, and it is the part that goes wrong: how a
 * growing answer is paced onto one message, when it spills into the next and
 * where the cut lands, what a refused write does to the next one, and what the
 * close owes the reader when a write fails. What differs is the platform's
 * calls, its caps and its rendering — the {@link EditInPlaceTransport} an
 * adapter hands in. Telegram renders the final text as HTML and falls back to
 * plain; Teams speaks Markdown natively and renders nothing.
 */

/** Wait a little; injected so a test can decline to. */
export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface EditInPlaceLimits {
  /** The platform's cap on one message's text. */
  maxChars: number;
  /** How often one message may be edited; a refused write is retried at this cadence too. */
  editIntervalMs: number;
  /** How often the typing indicator is re-sent while a run is in flight. */
  typingRefreshMs: number;
  /**
   * How far back from the cap a boundary may be looked for when the answer
   * outgrows one message. Which boundaries, and in what order, is
   * {@link cutPoint}'s.
   */
  softCutWindow: number;
  /**
   * What a message still being written ends in, so a reader arriving mid-run
   * does not take a sentence that stops halfway for the whole answer. Removed
   * by the final write.
   */
  cursor: string;
}

export interface EditInPlaceTransport {
  /** Open a new message and return its id. `first` says it is the reply's first — the one that quotes the question. */
  open(text: string, opts: { first: boolean; rendered: boolean }): Promise<string>;
  edit(messageId: string, text: string, opts: { rendered: boolean }): Promise<void>;
  /** A plain post, for what the final write could not place. */
  post(text: string): Promise<void>;
  typing(): Promise<void>;
  /**
   * The final rendering of the reply's messages, given together so a construct
   * cut by a message boundary can be closed on one side and reopened on the
   * other. Absent means the text is sent as it is, and there is no fallback.
   */
  render?: (pieces: readonly string[]) => string[];
  /**
   * The answer made safe to append a tail to — a code fence the run left open
   * closed, so the file link and the warnings after it read as prose. Absent
   * means the tail is appended as it is.
   */
  seal?: (answer: string) => string;
  /** The platform's answer to an edit that changes nothing; a success for our purposes. */
  isNotModified?: (error: unknown) => boolean;
  limits: EditInPlaceLimits;
  scope: LogScope;
  sleep?: Sleep;
}

/** One message of the reply, and where in the full text it starts. */
interface Segment {
  start: number;
  messageId?: string;
  /** The text the platform last accepted for this message, cursor excluded. */
  sent?: string;
  /** Whether that text was the rendered final. */
  final?: boolean;
  /**
   * When the platform last refused a write to this message. A refused write is
   * retried at the edit cadence, not on every delta: a bot the user has
   * blocked, or a 429, must not turn a two-thousand-delta answer into two
   * thousand requests.
   */
  refusedAt?: number;
}

function withSuffix(text: string, suffix: string): string {
  if (!suffix) {
    return text;
  }
  return text ? `${text}\n\n${suffix}` : suffix;
}

export function createEditInPlaceReply(transport: EditInPlaceTransport): ReplySink {
  const { limits, scope } = transport;
  const sleep = transport.sleep ?? realSleep;
  const segments: Segment[] = [];
  let lastWrite = 0;
  let lastTyping = 0;
  let finished = false;
  /**
   * Edits the platform has refused in a row. One heals on the next push; a
   * persistent refusal is the answer not arriving, and reads the same from
   * outside unless it is said.
   */
  let editFailures = 0;

  /**
   * Extend the layout so every character of `text` belongs to a segment. Every
   * segment leaves room for the cursor, the final one included: while it is
   * being written it carries one, and a segment sized to the cap without it
   * would be refused on exactly the push that filled it.
   */
  function layout(text: string): void {
    if (segments.length === 0) {
      segments.push({ start: 0 });
    }
    const room = limits.maxChars - limits.cursor.length;
    for (;;) {
      const last = segments[segments.length - 1];
      if (!last || text.length - last.start <= room) {
        return;
      }
      segments.push({ start: cutPoint(text, last.start, room, limits.softCutWindow) });
    }
  }

  function segmentText(full: string, index: number): string {
    const segment = segments[index];
    const next = segments[index + 1];
    if (!segment) {
      return "";
    }
    return full.slice(segment.start, next?.start);
  }

  /**
   * Put one segment's text on screen — opening its message the first time,
   * editing it after. `rendered` is the final rendering of `text`, sent first
   * and falling back to the plain text if the platform refuses it, so a
   * rendering defect costs formatting and never the answer.
   */
  async function write(
    index: number,
    text: string,
    opts: { cursor: boolean; rendered?: string },
  ): Promise<void> {
    const segment = segments[index];
    if (!segment) {
      return;
    }
    const plain = opts.cursor ? `${text}${limits.cursor}` : text;
    const attempts: Array<{ text: string; rendered: boolean }> =
      opts.rendered !== undefined
        ? [
            { text: opts.rendered, rendered: true },
            { text: plain, rendered: false },
          ]
        : [{ text: plain, rendered: false }];
    let lastError: unknown;
    for (const attempt of attempts) {
      try {
        if (segment.messageId === undefined) {
          segment.messageId = await transport.open(attempt.text, {
            first: index === 0,
            rendered: attempt.rendered,
          });
        } else {
          try {
            await transport.edit(segment.messageId, attempt.text, { rendered: attempt.rendered });
          } catch (error) {
            if (!transport.isNotModified?.(error)) {
              throw error;
            }
          }
        }
        segment.sent = text;
        segment.final = opts.rendered !== undefined;
        segment.refusedAt = undefined;
        editFailures = 0;
        return;
      } catch (error) {
        lastError = error;
        segment.refusedAt = Date.now();
        if (attempt.rendered) {
          log.warn(
            scope,
            `rendered reply refused, sending it plain: ${error instanceof Error ? error.message : "unknown"}`,
          );
        }
      }
    }
    throw lastError;
  }

  async function sendTyping(): Promise<void> {
    if (finished) {
      return;
    }
    const now = Date.now();
    if (now - lastTyping < limits.typingRefreshMs) {
      return;
    }
    lastTyping = now;
    await transport.typing().catch(() => {});
  }

  function editFailed(error: unknown): void {
    editFailures += 1;
    if (editFailures === 1 || editFailures % 10 === 0) {
      log.warn(scope, `reply edit refused (${editFailures} in a row)`, error);
    }
  }

  return {
    // The typing indicator is the whole vocabulary: a status, a step and a
    // nested step all say "still working", and the platform has nowhere to put
    // the words. What the run is doing shows up in the answer.
    status: () => sendTyping(),
    step: () => sendTyping(),
    async stepDone() {},

    keepStatusAlive() {
      const timer = setInterval(() => {
        void sendTyping();
      }, limits.typingRefreshMs);
      // A pending refresh must never be what keeps the process alive.
      unrefTimer(timer);
      return () => clearInterval(timer);
    },

    async push(fullText) {
      if (!fullText || finished) {
        return;
      }
      layout(fullText);
      const now = Date.now();
      const refusedRecently = (segment: Segment | undefined): boolean =>
        segment?.refusedAt !== undefined && now - segment.refusedAt < limits.editIntervalMs;
      // Every message but the last is full. Written once, plainly; the final
      // rendering comes with the close.
      for (let index = 0; index < segments.length - 1; index += 1) {
        const text = segmentText(fullText, index);
        if (segments[index]?.sent !== text && !refusedRecently(segments[index])) {
          await write(index, text, { cursor: false }).catch(editFailed);
        }
      }
      const index = segments.length - 1;
      const text = segmentText(fullText, index);
      const current = segments[index];
      if (!current || current.sent === text || refusedRecently(current)) {
        return;
      }
      // No pacing on a message's first write: the point of it is that something
      // shows up quickly. A failure leaves the segment unopened — and marked as
      // refused, so the retry comes at the edit cadence with everything
      // accumulated since, not on the next delta.
      if (current.messageId !== undefined && now - lastWrite < limits.editIntervalMs) {
        return;
      }
      lastWrite = now;
      await write(index, text, { cursor: true }).catch(editFailed);
    },

    async finish(fullText, suffix) {
      finished = true;
      const full = withSuffix(suffix && transport.seal ? transport.seal(fullText) : fullText, suffix);
      // Nothing was ever opened and there is nothing to say. Whoever knows what
      // else the run delivered — a picture — decides whether that is a warning.
      if (!full) {
        return;
      }
      layout(full);
      const texts = segments.map((_, index) => segmentText(full, index));
      // Rendered together, so a construct cut by a message boundary reads the
      // same on both sides of it.
      const rendered = transport.render?.(texts);
      let written = 0;
      for (let index = 0; index < segments.length; index += 1) {
        const text = texts[index] ?? "";
        const segment = segments[index];
        if (segment?.final && segment.sent === text) {
          continue;
        }
        // Paced between messages, like every other write: the close of a long
        // answer is several edits into one chat's budget, and a burst is what a
        // platform answers with 429. The first is not delayed — a one-message
        // reply closes as fast as it streamed.
        if (written > 0) {
          const wait = limits.editIntervalMs - (Date.now() - lastWrite);
          if (wait > 0) {
            await sleep(wait);
          }
        }
        written += 1;
        lastWrite = Date.now();
        try {
          await write(index, text, { cursor: false, ...(rendered ? { rendered: rendered[index] } : {}) });
        } catch (error) {
          log.error(scope, "final reply write failed", error);
          // The message on screen still carries the cursor or an older text.
          // What the platform never took is posted on its own rather than lost
          // — only the part it never took: `sent` is what it accepted, and a
          // repeated head would be its own defect. That failure was silent for
          // a whole release on the Slack surface.
          const undelivered = text.slice(segment?.sent?.length ?? 0);
          if (undelivered) {
            await transport
              .post(undelivered)
              .catch((fallbackError) => log.error(scope, "fallback reply failed too", fallbackError));
          }
        }
      }
    },
  };
}
