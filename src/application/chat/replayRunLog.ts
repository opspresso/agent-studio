/**
 * Catching up on a run already in progress.
 *
 * Replays the whole log from the start and then follows it, so a browser that
 * reloaded ends up watching the same run it left. Always from the start, never
 * from a cursor: `reduceChunk` on the client is a pure fold, so rebuilding the
 * turn from the beginning produces exactly what was on screen — and a cursor
 * would be one more thing to get wrong for no gain.
 *
 * How it ends, in order of what it can prove:
 *
 * - a terminal entry — the run finished, and the assistant message is already
 *   written (see the ordering `runLog.ts` keeps);
 * - the claim is gone or names another run — the run finished without ever being
 *   left, so it wrote no log at all and its answer is in the conversation;
 * - the claim is there but expired — the instance running it died. Nothing will
 *   ever finish this, and saying so is the only honest ending.
 */

import { isLiveClaim } from "@/domain/chat/types";
import { log } from "@/shared/logger";
import { unrefTimer } from "@/shared/unrefTimer";
import type { ChatDeps } from "./deps";
import { ChatNotFoundError } from "./errors";

/** How often the log is checked for new entries. */
const POLL_INTERVAL_MS = 400;

/** Rows drained per read before the replay checks whether the log is quiet. */
const RUN_LOG_PAGE_SIZE = 100;

/**
 * How long a live run may show nothing before the reader is told why.
 *
 * A run writes nothing while someone is attached, so an empty log usually means
 * another window is holding the connection — not that the run is stuck. It can
 * also be the ordinary reload race, where this reader arrives before the old
 * connection's close is processed, which is why it is a delay and not an
 * immediate notice.
 */
const QUIET_NOTICE_MS = 5_000;

const LOST_RUN_ERROR =
  "The instance running this reply was lost; its claim expired without an answer.";

const QUIET_NOTICE =
  "This reply is being streamed to another window. It appears here when that window closes, or when the reply is finished.";

export interface ReplayRunLogInput {
  chatId: string;
  runId: string;
  userEmail: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    unrefTimer(timer);
  });
}

function parseFrames(payload: string): unknown[] {
  try {
    const frames: unknown = JSON.parse(payload);
    return Array.isArray(frames) ? frames : [];
  } catch (error) {
    log.error("chat", "run log entry could not be parsed", error);
    return [{ warning: "Part of this reply could not be read back." }];
  }
}

/**
 * Check the reader may see this chat, then hand back the replay.
 *
 * The check is awaited rather than done inside the generator because the route
 * wraps the stream in an envelope frame: a refusal raised on the first `next()`
 * would arrive *after* that frame, as a mid-stream error on a 200, instead of as
 * the 404 it is.
 */
export async function openRunLogReplay(
  deps: ChatDeps,
  input: ReplayRunLogInput,
): Promise<AsyncGenerator<unknown>> {
  const chat = await deps.chats.get(input.chatId);
  // Non-owner access is indistinguishable from missing, as everywhere a chat is
  // read.
  if (!chat || chat.ownerEmail !== input.userEmail) {
    throw new ChatNotFoundError();
  }
  return replayRunLog(deps, input);
}

async function* replayRunLog(
  deps: ChatDeps,
  input: ReplayRunLogInput,
): AsyncGenerator<unknown> {
  let nextSeq = 0;
  let quietSince = Date.now();
  let noticed = false;

  for (;;) {
    const entries = await deps.runLog.read(
      input.chatId,
      input.runId,
      nextSeq,
      RUN_LOG_PAGE_SIZE,
    );
    for (const entry of entries) {
      // Rows that are not there, checked entry by entry rather than once per
      // read. Two things make a hole: the retention window taking the start of
      // a long-abandoned run, and a flush that failed after its sequence
      // numbers were already spent — which lands in the *middle*, and just as
      // easily inside one read's batch as between two reads. A check on the
      // batch's first row walked straight past the former. The run's own
      // dropped-frame notice covers only what it chose to forget.
      if (entry.seq > nextSeq) {
        yield {
          warning:
            nextSeq === 0
              ? "The beginning of this reply is no longer available; what follows starts part-way through."
              : "Part of this reply could not be read back; what follows skips it.",
        };
      }
      for (const frame of parseFrames(entry.payload)) {
        yield frame;
      }
      nextSeq = entry.seq + 1;
      if (entry.terminal) {
        if (entry.error) {
          yield { error: entry.error };
        }
        return;
      }
    }

    if (entries.length > 0) {
      quietSince = Date.now();
      if (entries.length === RUN_LOG_PAGE_SIZE) {
        continue;
      }
    } else {
      // Liveness is asked only when the log is quiet: a batch just delivered
      // means the run was alive to write it, and the claim is one
      // strongly-consistent read per poll — paid beside every delivered batch,
      // it doubled the cost of exactly the iterations that were going well.
      const active = await deps.chats.getActiveRun(input.chatId);
      if (active === null || active.runId !== input.runId) {
        // No terminal entry and no claim: the run finished with a reader
        // attached, so it never wrote itself down. Its answer is in the
        // conversation, which the client fetches once this stream ends.
        return;
      }
      if (!isLiveClaim(active, Date.now())) {
        yield { error: LOST_RUN_ERROR };
        return;
      }
      if (!noticed && Date.now() - quietSince >= QUIET_NOTICE_MS) {
        noticed = true;
        yield { warning: QUIET_NOTICE };
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
}
