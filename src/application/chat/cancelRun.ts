/**
 * Stopping a chat run, and how a running one hears about it.
 *
 * Closing the tab used to be the stop button: the connection dropped, the SSE
 * layer aborted the run. Now that a run outlives its reader there has to be a
 * deliberate one, or a user who asked the wrong question holds a concurrency
 * slot and the chat's run lease until the run deadline.
 *
 * The request is persisted rather than kept in memory because the instance
 * serving the stop is not necessarily the one running the answer. That is the
 * same reason the A2A executor polls its task store
 * (`src/application/a2a/executor.ts`) instead of holding a flag.
 */

import type { ChatRepository } from "@/domain/chat/repository";
import { log } from "@/shared/logger";
import { startSequentialPoll } from "@/shared/sequentialPoll";
import type { ChatDeps } from "./deps";
import { ChatForbiddenError, ChatNotFoundError } from "./errors";

/**
 * How often a run checks whether it was asked to stop. Slow enough to be free
 * next to the model calls it runs beside, fast enough that a press feels like a
 * press — and it has to be a poll at all because a run producing nothing (a hung
 * provider, one long image call) has no other moment to notice.
 */
const CANCEL_POLL_MS = 2_000;

/**
 * What a run is aborted *with* when the abort is one of ours.
 *
 * The engine cannot tell the kinds of abort apart — it rethrows whichever one it
 * got — so the reason is where the intent survives. Without it a deliberate stop
 * arrives at the reader as `This operation was aborted` in a red banner, and is
 * recorded in the replay log as a failure.
 *
 * They are two reasons rather than one because they are two different things to
 * be told. A stop is something the reader did; a run whose chat has moved on was
 * ended *for* them, and reporting that as "Stopped." blames a press that never
 * happened.
 */
export const STOP_REASON = "chat-run-stopped";
export const SUPERSEDED_REASON = "chat-run-superseded";

/** What the reader is told in place of that error. */
export const STOPPED_NOTICE = "Stopped.";
export const SUPERSEDED_NOTICE =
  "This reply was ended early: the chat is no longer this run's to answer.";

/**
 * The note this run ends on, or `undefined` when the abort was not ours and the
 * run really did fail.
 */
export function endNoticeFor(signal: AbortSignal | undefined): string | undefined {
  if (signal?.aborted !== true) {
    return undefined;
  }
  if (signal.reason === STOP_REASON) {
    return STOPPED_NOTICE;
  }
  return signal.reason === SUPERSEDED_REASON ? SUPERSEDED_NOTICE : undefined;
}

export interface CancelChatRunInput {
  chatId: string;
  runId: string;
  userEmail: string;
}

/**
 * Ask a run to stop. Silently a no-op when it already finished — the press
 * raced the answer, which is not something to report as a failure.
 */
export async function cancelChatRun(
  deps: ChatDeps,
  input: CancelChatRunInput,
): Promise<{ cancelled: boolean }> {
  const chat = await deps.chats.get(input.chatId);
  if (!chat) {
    throw new ChatNotFoundError();
  }
  if (chat.ownerEmail !== input.userEmail) {
    throw new ChatForbiddenError();
  }
  return { cancelled: await deps.chats.requestCancel(input.chatId, input.runId) };
}

/**
 * Watch for a stop while `runId` runs, aborting `controller` when one lands.
 * Returns the stop function; call it once the run is over, or the poll outlives
 * the thing it was watching.
 */
export function watchChatCancel(
  chats: ChatRepository,
  chatId: string,
  runId: string,
  controller: AbortController,
): () => void {
  return startSequentialPoll({
    intervalMs: CANCEL_POLL_MS,
    async poll(signal) {
      const active = await chats.getActiveRun(chatId);
      if (signal.aborted) {
        return;
      }
      // A lease that no longer names this run ends it too — the chat was
      // deleted, or something else has taken it over, and this run is
      // finishing into nothing either way. Said under its own reason, because
      // nobody pressed anything.
      if (active === null || active.runId !== runId) {
        controller.abort(SUPERSEDED_REASON);
      } else if (active.cancelRequestedAt) {
        controller.abort(STOP_REASON);
      }
    },
    onError: (error) => log.error("chat", "cancel poll failed", error),
  });
}
