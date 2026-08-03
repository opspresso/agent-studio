import type { Chat, ChatMessage } from "@/domain/chat/types";
import type { ChatDeps } from "./deps";
import { ChatNotFoundError } from "./errors";
import { resolveMessageImages } from "./resolveImages";
import { VIEW_URL_TTL_SECONDS } from "./imageUrls";

export interface ChatWithMessages {
  chat: Chat;
  messages: ChatMessage[];
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
  // Signed for the reader who is about to look at them. A stored row holds an
  // object key, never an address that keeps working after this response.
  const withImages = await resolveMessageImages(
    messages.map(forReading),
    deps.signImageUrl,
    VIEW_URL_TTL_SECONDS,
  );
  return { chat, messages: withImages };
}
