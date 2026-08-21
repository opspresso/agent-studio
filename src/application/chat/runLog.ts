/**
 * Writing a run down so a reader who left can catch up.
 *
 * The tee sits **outside** `runAndPersist`, which is what makes the log's
 * ordering worth anything:
 *
 *   persist → terminal entry → release the lease
 *
 * A reader that sees the terminal entry can fetch the chat and find the
 * assistant message already there; a reader that sees the lease gone has
 * therefore already seen the terminal entry. Inside `runAndPersist` the terminal
 * entry would land before the S3 uploads and the message writes, and a reader
 * following it would read a turn with no reply. That is also why the lease
 * release lives here rather than in `runAndPersist` — with it there, "no lease,
 * no terminal entry" is a real state for one write's worth of time, and a tail
 * that lands in it reports a finished run as lost.
 *
 * **Nothing is written while someone is reading.** They are already seeing every
 * frame; writing them down as well would cost a DynamoDB write every half-second
 * of every run, to serve the few that get abandoned. The frames are buffered
 * instead, and the whole run so far is flushed the moment the reader leaves.
 * The cost of that choice: while a reader is attached the log is empty, so a
 * second window cannot watch the same run live — see `replayRunLog`, which says
 * so rather than showing a blank.
 */

import { isTopLevelChunk, type EngineChunk } from "@/domain/llm/types";
import type { RunLogEntry } from "@/domain/chat/runLog";
import { log } from "@/shared/logger";
import { unrefTimer } from "@/shared/unrefTimer";
import type { ChatDeps } from "./deps";

/** How often a detached run writes down what it has produced since the last write. */
const FLUSH_INTERVAL_MS = 500;

/**
 * How much of a run is held for a reader that has not left yet. The buffer is
 * the whole run so far, because a replay starts from the beginning; past this
 * the oldest frames go, and the reader is told they did (see `droppedFrames`).
 */
const MAX_BUFFERED_BYTES = 350_000;

/**
 * What the buffer is trimmed back to once it overflows. Dropping exactly enough
 * for each new frame means one `shift` per frame for the rest of the run, over
 * an array holding thousands of them; trimming to a low-water mark makes it one
 * pass per 70KB produced instead.
 */
const BUFFER_LOW_WATER_BYTES = 280_000;

/** One stored row, kept well under the 400KB item limit. */
const MAX_ROW_BYTES = 300_000;

/**
 * A single frame's ceiling. A tool result is the only thing here that can be
 * arbitrarily large, and one of them must not be able to push a row past the
 * item limit on its own.
 */
const MAX_FRAME_BYTES = 100_000;

export interface RunLogTee {
  stream: AsyncGenerator<EngineChunk>;
  /**
   * Call when the reader leaves. From here on the run writes itself down,
   * starting with everything it has produced so far.
   */
  onClientGone: () => void;
}

function warningFrame(message: string): string {
  return JSON.stringify({ warning: message });
}

/**
 * A frame's size as DynamoDB counts it.
 *
 * `String.length` counts UTF-16 units, and `JSON.stringify` leaves non-ASCII
 * text alone — so a Korean run measured that way is three times the size it
 * reports, and a row built to a 300,000-"character" budget is a 900KB item the
 * service refuses. `run.ts` weighs its own budget the same way, for the same
 * reason.
 */
function frameBytes(frame: string): number {
  return Buffer.byteLength(frame, "utf8");
}

/**
 * What goes in the log for one chunk.
 *
 * An image never does: the bytes are far past a row, and even at the row limit a
 * few of them would be the whole buffer. A reader catching up gets a note in its
 * place, plus the picture itself once the run ends and the message is written —
 * unless nothing stores images here, in which case the original connection was
 * the only place it ever existed, and that is worth saying out loud.
 *
 * Which is why every chunk is serialised as it arrives rather than at flush
 * time, even for the runs — most of them — that never detach and never write a
 * byte. Buffering the chunks themselves would be cheaper per frame and would
 * hold a generated image's megabytes for the whole run, for a reader who is
 * probably still there.
 */
/**
 * What a chunk may carry alongside reasoning and still be nothing but reasoning:
 * who produced it, and the delta it travels on.
 */
const RIDES_WITH_REASONING = new Set(["traceId", "author", "authorPath", "delta"]);

/**
 * A chunk whose whole payload is the run's thinking.
 *
 * Written as "carries nothing else" rather than a list of the axes it must not
 * carry, so an axis added later fails closed. The engine yields reasoning on
 * its own chunk today; a future producer merging it with the answer would
 * otherwise have the answer dropped along with it by the substitution below.
 */
function isReasoningOnly(chunk: EngineChunk): boolean {
  const delta = chunk.delta;
  if (!delta?.reasoningContent || delta.content !== undefined || delta.toolCalls !== undefined) {
    return false;
  }
  return Object.keys(chunk).every((key) => RIDES_WITH_REASONING.has(key));
}

/**
 * What stands in for a run's thinking, once per run.
 *
 * Reasoning streams a token at a time, and each frame pays ~33 bytes of
 * envelope for a few bytes of text: a run that thinks for 20k tokens produces
 * 20k frames and hundreds of kilobytes against a 350KB buffer that drops from
 * the front. What it drops is the beginning of the answer — a resumed reader
 * would get "the first N part(s) are no longer available" followed by a reply
 * starting mid-sentence, while the saved message holds the whole thing. So the
 * buffer is spent on the answer, and the thinking arrives with the message the
 * run writes on its way out.
 */
function reasoningNote(): string {
  return warningFrame("The reasoning for this run appears on the saved message once it finishes.");
}

function frameFor(chunk: EngineChunk, imagesArePersisted: boolean): string {
  if (chunk.file) {
    // Same rule as an image, and the same reason: a megabyte of base64 has no
    // business in a replay buffer. The file itself is already stored, so the
    // reader gets it from the conversation rather than from here.
    return warningFrame(
      chunk.file.key
        ? `A file (${chunk.file.name}) was produced here. It appears in the conversation once this run finishes.`
        : `A file (${chunk.file.name}) was produced here and is not kept.`,
    );
  }
  if (chunk.image) {
    return warningFrame(
      imagesArePersisted
        ? "An image was generated here. It appears in the conversation once this run finishes."
        : "An image was generated here and is not kept: it was only visible on the connection that asked for it.",
    );
  }
  let frame: string;
  try {
    frame = JSON.stringify(chunk);
  } catch (error) {
    log.error("chat", "run log frame could not be serialised", error);
    return warningFrame("Part of this run could not be kept for replay.");
  }
  const size = frameBytes(frame);
  if (size > MAX_FRAME_BYTES) {
    return warningFrame(
      `A ${size}-byte part of this run was too large to keep for replay; it is in the saved conversation.`,
    );
  }
  return frame;
}

function createWriter(deps: ChatDeps, chatId: string, runId: string) {
  /** Serialised frames not yet written. */
  let buffered: string[] = [];
  let bufferedBytes = 0;
  let droppedFrames = 0;
  let seq = 0;
  let detached = false;
  let ended: { error?: string } | undefined;
  let pumping: Promise<void> | undefined;
  let wake = (): void => undefined;
  const ending = new Promise<void>((resolve) => {
    wake = resolve;
  });

  async function write(task: () => Promise<void>): Promise<void> {
    try {
      await task();
    } catch (error) {
      // A log nobody can write is a resume that will not work; the run itself is
      // unaffected and must not be taken down with it. What it costs is a hole:
      // the rows are gone and their sequence numbers are spent, which `replayRunLog`
      // reports as the gap it is rather than reading straight past.
      log.error("chat", "run log write failed", error);
    }
  }

  function push(frame: string): void {
    buffered.push(frame);
    bufferedBytes += frameBytes(frame);
    if (bufferedBytes <= MAX_BUFFERED_BYTES) {
      return;
    }
    let dropped = 0;
    while (bufferedBytes > BUFFER_LOW_WATER_BYTES && dropped < buffered.length - 1) {
      bufferedBytes -= frameBytes(buffered[dropped]!);
      dropped += 1;
    }
    buffered = buffered.slice(dropped);
    droppedFrames += dropped;
  }

  /** The substitution above says the same thing every time; it is said once. */
  let reasoningNoted = false;

  function record(chunk: EngineChunk): void {
    if (isReasoningOnly(chunk)) {
      // A child's thinking is dropped without a word. The note points at the
      // saved message, and `runAndPersist` keeps top-level reasoning only — so
      // said over a subagent's it would send the reader to a field that will
      // never exist, and burn the one note the parent's own thinking needs.
      if (!isTopLevelChunk(chunk)) {
        return;
      }
      if (reasoningNoted) {
        return;
      }
      reasoningNoted = true;
      push(reasoningNote());
      return;
    }
    push(frameFor(chunk, deps.artifacts !== undefined));
  }

  /** The buffered frames as rows, oldest first, each under the item limit. */
  function takeRows(): RunLogEntry[] {
    if (droppedFrames > 0) {
      // In place, where the gap is: a replay that silently starts in the middle
      // reads as an answer that began that way.
      buffered.unshift(
        warningFrame(
          `The first ${droppedFrames} part(s) of this run are no longer available to replay.`,
        ),
      );
      droppedFrames = 0;
    }
    const frames = buffered;
    buffered = [];
    bufferedBytes = 0;

    const rows: RunLogEntry[] = [];
    let batch: string[] = [];
    let batchBytes = 0;
    for (const frame of frames) {
      const size = frameBytes(frame);
      if (batch.length > 0 && batchBytes + size > MAX_ROW_BYTES) {
        rows.push({ seq: seq++, payload: `[${batch.join(",")}]` });
        batch = [];
        batchBytes = 0;
      }
      batch.push(frame);
      batchBytes += size;
    }
    if (batch.length > 0) {
      rows.push({ seq: seq++, payload: `[${batch.join(",")}]` });
    }
    return rows;
  }

  async function writeBuffered(): Promise<void> {
    const rows = takeRows();
    if (rows.length > 0) {
      await deps.runLog.append(chatId, runId, rows);
    }
  }

  async function writeTerminal(error: string | undefined): Promise<void> {
    await deps.runLog.append(chatId, runId, [
      { seq: seq++, payload: "[]", terminal: true, ...(error ? { error } : {}) },
    ]);
  }

  /**
   * Wait out the flush interval, or wake early because the run finished — a run
   * that ends mid-wait releases its lease as soon as the last row lands rather
   * than half a second later.
   *
   * The wake handler is registered once, not once per iteration: a run that
   * lives to the deadline flushes over a thousand times, and a `then` per pass
   * would leave that many closures held on one promise until it settles.
   */
  const waiters = new Set<() => void>();
  void ending.then(() => {
    for (const waiter of waiters) {
      waiter();
    }
    waiters.clear();
  });

  function sleepUntilNextFlush(): Promise<void> {
    return new Promise((resolve) => {
      let wakeEarly = (): void => undefined;
      const timer = setTimeout(() => {
        waiters.delete(wakeEarly);
        resolve();
      }, FLUSH_INTERVAL_MS);
      unrefTimer(timer);
      wakeEarly = () => {
        clearTimeout(timer);
        resolve();
      };
      waiters.add(wakeEarly);
    });
  }

  /**
   * The only thing that writes, and it writes one row set at a time — rows carry
   * the sequence they are stored at, so two flushes in flight would race for it.
   * A failed flush does not take the terminal entry down with it: that entry is
   * what a reader is waiting on to know the run is over.
   */
  async function pump(): Promise<void> {
    for (;;) {
      await write(writeBuffered);
      if (ended) {
        const { error } = ended;
        await write(() => writeTerminal(error));
        return;
      }
      await sleepUntilNextFlush();
    }
  }

  return {
    record,
    detach(): void {
      // `ended` closes the door: a disconnect landing while `finish` is still
      // unwinding would otherwise start a second pump, which writes the whole
      // buffer and a *second* terminal entry after the lease has been released
      // — inverting the one ordering a resume depends on.
      if (!detached && !ended) {
        detached = true;
        pumping = pump();
      }
    },
    /**
     * The run is over. Writes nothing at all when nobody ever left — the log
     * exists for a reader to catch up from, and there is none.
     */
    async finish(error?: string): Promise<void> {
      ended = error === undefined ? {} : { error };
      wake();
      if (pumping) {
        await pumping;
      }
    },
  };
}

export function teeToRunLog(
  deps: ChatDeps,
  chatId: string,
  runId: string,
  source: AsyncGenerator<EngineChunk>,
): RunLogTee {
  const writer = createWriter(deps, chatId, runId);

  async function* record(): AsyncGenerator<EngineChunk> {
    let error: string | undefined;
    try {
      for await (const chunk of source) {
        writer.record(chunk);
        yield chunk;
      }
    } catch (thrown) {
      // Whatever reaches here is a genuine failure: a stop is answered a layer
      // down, by `runAndPersist`, which is the only place that can also write
      // the note onto the message it just saved.
      error = thrown instanceof Error ? thrown.message : String(thrown);
      throw thrown;
    } finally {
      // `source` is `runAndPersist`, so its own `finally` — the assistant
      // message, the images — has already run by the time this does. That is
      // the ordering the terminal entry promises a reader.
      await writer.finish(error);
      try {
        await deps.chats.releaseRun(chatId, runId);
      } catch (thrown) {
        // Last statement of a `finally`: a throw here would replace the run's
        // real outcome, turning a delivered answer into an error the reader
        // sees after reading it. The claim expires on its own.
        log.error("chat", "run lease release failed", thrown);
      }
    }
  }

  return { stream: record(), onClientGone: () => writer.detach() };
}
