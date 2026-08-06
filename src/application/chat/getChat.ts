import { isLiveClaim, type Chat, type ChatMessage } from "@/domain/chat/types";
import type { ChatDeps } from "./deps";
import { ChatNotFoundError } from "./errors";
import { resolveMessageImages } from "./resolveImages";
import { VIEW_URL_TTL_SECONDS } from "./imageUrls";
import { log } from "@/shared/logger";

export interface ChatWithMessages {
  chat: Chat;
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

/** Load a chat's meta and messages. Non-owner access is indistinguishable from missing. */
export async function getChat(
  deps: ChatDeps,
  chatId: string,
  userEmail: string,
): Promise<ChatWithMessages> {
  const chat = await deps.chats.get(chatId);
  if (!chat || chat.ownerEmail !== userEmail) {
    throw new ChatNotFoundError();
  }
  const messages = await deps.chats.listMessages(chatId);
  const active = await deps.chats.getActiveRun(chatId);
  const running = isLiveClaim(active, Date.now());
  // Signed for the reader who is about to look at them. A stored row holds an
  // object key, never an address that keeps working after this response.
  const resolved = await resolveMessageImages(
    messages.map(forReading),
    deps.signImageUrl,
    VIEW_URL_TTL_SECONDS,
  );
  if (resolved.dropped > 0) {
    // The view has nowhere to say this: `warnings` belongs to an assistant turn,
    // and the images a reader misses most are the ones they attached themselves.
    // A line naming the chat is what lets an operator answer "where did my
    // picture go" with something other than a guess.
    log.warn("chat", `${resolved.dropped} image(s) of chat ${chatId} could not be addressed`);
  }
  return {
    chat,
    messages: resolved.messages,
    ...(running && active ? { activeRun: { runId: active.runId } } : {}),
  };
}
