import type { ChatMessage, UserChatMessage } from "@/domain/chat/types";
import type { ChatMessageInput } from "@/domain/llm/types";

/**
 * A stored user turn: text, or content parts when the turn carried attachments.
 * The stored images are object-storage URLs (the provider fetches them), so a
 * replayed attachment is visible to the model but not editable — only the turn
 * that uploaded it had the bytes in hand.
 */
function userMessage(message: UserChatMessage): ChatMessageInput {
  const images = message.images ?? [];
  if (images.length === 0) {
    return { role: "user", content: message.content };
  }
  return {
    role: "user",
    content: [
      ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
      ...images.map((image) => ({
        type: "image_url" as const,
        image_url: { url: image.url },
      })),
    ],
  };
}

/**
 * Convert stored chat messages to OpenAI-shaped engine messages.
 *
 * A `tool` message is only emitted when a preceding assistant message declared a
 * matching `tool_calls` entry — an orphaned tool message (no matching call) would
 * make the payload invalid, so it is kept for UI display but dropped here.
 */
export function toEngineMessages(messages: ChatMessage[]): ChatMessageInput[] {
  const out: ChatMessageInput[] = [];
  const knownToolCallIds = new Set<string>();

  for (const message of messages) {
    if (message.role === "user") {
      out.push(userMessage(message));
    } else if (message.role === "assistant") {
      const mapped: ChatMessageInput = { role: "assistant", content: message.content };
      if (message.toolCalls && message.toolCalls.length > 0) {
        mapped.tool_calls = message.toolCalls;
        for (const call of message.toolCalls) {
          if (call.id) {
            knownToolCallIds.add(call.id);
          }
        }
      }
      out.push(mapped);
    } else if (message.role === "tool") {
      if (message.toolCallId && knownToolCallIds.has(message.toolCallId)) {
        out.push({ role: "tool", content: message.content, tool_call_id: message.toolCallId });
      }
    }
  }

  return out;
}
