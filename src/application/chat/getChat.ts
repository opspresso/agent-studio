import { isLiveClaim, type Chat, type ChatMessage } from "@/domain/chat/types";
import type { ChatDeps } from "./deps";
import { ChatNotFoundError } from "./errors";
import { resolveMessageImages } from "./resolveImages";
import { resolveMessageFiles } from "./resolveFiles";
import { VIEW_URL_TTL_SECONDS } from "@/application/artifact/urlTtl";
import { log } from "@/shared/logger";
import { listChatMessages } from "./messageList";

export interface ChatWithMessages {
  chat: Chat;
  /**
   * The chat's messages — all of them, or only those after `sinceSeq` when the
   * caller named one. A caller that asks for the tail is a caller that already
   * holds the head, and it merges rather than replaces.
   */
  messages: ChatMessage[];
  /**
   * The run in flight, when there is one — what a browser that reloaded mid-run
   * names to pick it back up, or to stop it.
   *
   * Derived here rather than carried on `Chat`: the claim is stored on the chat
   * row, and a `Chat` that holds it is a `Chat` that `update()` writes back,
   * which is how a live lease gets overwritten by a stale copy. Absent once the
   * claim has expired — an instance that died mid-run leaves one behind, and it
   * says nothing about a run still running.
   */
  activeRun?: { runId: string };
}

/**
 * A document's extracted text is server-side data.
 *
 * The reader sees the file's name and how much of it was read; the text itself
 * exists so a *later turn* still has the document, and the replay that needs it
 * reads the stored rows directly. Sending it to the browser would put up to
 * 40,000 characters per turn on the wire on every chat open, for a view that
 * renders neither.
 */
function forReading(message: ChatMessage): ChatMessage {
  if (message.role !== "user" || !message.documents) {
    return message;
  }
  return {
    ...message,
    documents: message.documents.map(({ name, note }) => ({
      name,
      text: "",
      ...(note ? { note } : {}),
    })),
  };
}

/**
 * Load a chat's meta and messages. Non-owner access is indistinguishable from
 * missing.
 *
 * `sinceSeq` narrows the read to the rows written after it — what the thread
 * asks for when a run finishes, having watched that run arrive. Without it the
 * whole transcript is read and every stored image and file in it re-signed, on
 * every turn, at a cost that grows with the chat. The chat row and the run
 * claim are read either way: the title can have been written mid-run, and
 * whether a run is still going is the other half of what the caller asked.
 */
export async function getChat(
  deps: ChatDeps,
  chatId: string,
  userEmail: string,
  options: { sinceSeq?: number } = {},
): Promise<ChatWithMessages> {
  const chat = await deps.chats.get(chatId);
  if (!chat || chat.ownerEmail !== userEmail) {
    throw new ChatNotFoundError();
  }
  const messages = await listChatMessages(deps.chats, chatId, options.sinceSeq);
  const active = await deps.chats.getActiveRun(chatId);
  const running = isLiveClaim(active, Date.now());
  // Signed for the reader who is about to look at them. A stored row holds an
  // object key, never an address that keeps working after this response.
  const resolved = await resolveMessageImages(
    messages.map(forReading),
    deps.artifacts?.objects.sign,
    VIEW_URL_TTL_SECONDS,
  );
  if (resolved.dropped > 0) {
    // The view has nowhere to say this: `warnings` belongs to an assistant turn,
    // and the images a reader misses most are the ones they attached themselves.
    // A line naming the chat is what lets an operator answer "where did my
    // picture go" with something other than a guess.
    log.warn("chat", `${resolved.dropped} image(s) of chat ${chatId} could not be addressed`);
  }
  // Files, signed only here. The replay resolves images and not these on
  // purpose — see `resolveFiles.ts`.
  const withFiles = await resolveMessageFiles(
    resolved.messages,
    deps.artifacts?.objects.sign,
    VIEW_URL_TTL_SECONDS,
  );
  if (withFiles.dropped > 0) {
    log.warn("chat", `${withFiles.dropped} file(s) of chat ${chatId} could not be addressed`);
  }
  return {
    chat,
    messages: withFiles.messages,
    ...(running && active ? { activeRun: { runId: active.runId } } : {}),
  };
}
