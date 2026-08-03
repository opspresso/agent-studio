import type { Chat, ViewableChatMessage } from "@/domain/chat/types";
import type { ChatDeps } from "./deps";
import { ChatNotFoundError } from "./errors";
import { IMAGE_VIEW_TTL_SECONDS, withSignedImages } from "./imageUrls";

export interface ChatWithMessages {
  chat: Chat;
  /**
   * `Viewable`, not `ChatMessage`: every image here is a URL a reader can
   * fetch, because they have all been through the resolver. The wider type
   * would compile — a resolved image satisfies the stored union — and would
   * quietly let a future reader hand out rows that were never signed, which is
   * the one thing the distinction exists to prevent.
   */
  messages: ViewableChatMessage[];
  /** What the transcript is missing — today, images that could not be signed. */
  warnings: string[];
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
function forReading(message: ViewableChatMessage): ViewableChatMessage {
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
  // Signed here rather than at write time: the stored row names an object, and
  // what the browser is handed is a URL that stops working on its own.
  const viewable = await withSignedImages(deps.images, messages, IMAGE_VIEW_TTL_SECONDS);
  return {
    chat,
    messages: viewable.messages.map(forReading),
    warnings: viewable.warnings,
  };
}
