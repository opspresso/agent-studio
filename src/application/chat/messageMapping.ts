import type { ChatMessage } from "@/domain/chat/types";
import type { ChatMessageInput } from "@/domain/llm/types";

function toolCallId(toolCall: unknown): string | undefined {
  if (toolCall && typeof toolCall === "object" && "id" in toolCall) {
    const id = (toolCall as { id: unknown }).id;
    return typeof id === "string" ? id : undefined;
  }
  return undefined;
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
      out.push({ role: "user", content: message.content });
    } else if (message.role === "assistant") {
      const mapped: ChatMessageInput = { role: "assistant", content: message.content };
      if (message.toolCalls && message.toolCalls.length > 0) {
        mapped.tool_calls = message.toolCalls;
        for (const call of message.toolCalls) {
          const id = toolCallId(call);
          if (id) {
            knownToolCallIds.add(id);
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
