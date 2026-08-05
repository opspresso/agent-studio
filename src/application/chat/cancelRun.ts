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
import type { ChatDeps } from "./deps";
import { ChatForbiddenError, ChatNotFoundError } from "./errors";

/**
 * How often a run checks whether it was asked to stop. Slow enough to be free
 * next to the model calls it runs beside, fast enough that a press feels like a
 * press — and it has to be a poll at all because a run producing nothing (a hung
 * provider, one long image call) has no other moment to notice.
 */
const CANCEL_POLL_MS = 2_000;

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
  const timer = setInterval(() => {
    void chats.getActiveRun(chatId).then(
      (active) => {
        // Also stops on a lease that no longer names this run: something else
        // has taken the chat over, so this one is finishing into nothing.
        if (active === null || active.runId !== runId || active.cancelRequestedAt) {
          controller.abort();
        }
      },
      (error) => {
        log.error("chat", "cancel poll failed", error);
      },
    );
  }, CANCEL_POLL_MS);
  // Never a reason to hold the process open by itself.
  (timer as unknown as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}
