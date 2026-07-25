import type { AssistantChatMessage, ChatMessage, UserChatMessage } from "@/domain/chat/types";
import type { ChannelToolCall, ChatMessageInput } from "@/domain/llm/types";

/**
 * How many earlier assistant turns replay their tool calls and results. Without
 * any, a follow-up question ("what was in the second row?") reaches a model that
 * cannot see what the tool returned, so it calls the tool again — or says it
 * cannot tell. Replaying *every* turn is the other failure: tool output is the
 * bulkiest thing in a chat, and it would crowd out the conversation itself.
 */
const DEFAULT_TOOL_REPLAY_TURNS = 3;

/**
 * Total replayed tool text. Spent newest-first, because the turn just before
 * the question is the one it is usually about. A single stored result may be
 * 100KB on its own, so without this the last few turns alone could fill the
 * whole context window.
 */
const MAX_REPLAYED_TOOL_CHARS = 20_000;

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

export interface ToEngineMessagesOptions {
  /** Assistant turns whose tool calls replay. 0 replays none. */
  toolReplayTurns?: number;
}

/**
 * Convert stored chat messages to OpenAI-shaped engine messages.
 *
 * Storage order within a turn is `tool…` then `assistant` (the tool rows are
 * written as they arrive, the answer once it is complete), which is the reverse
 * of what the wire format requires. So tool rows are not emitted where they sit:
 * each is paired with the assistant message that declared its call and emitted
 * right after it. A row with no matching call — a subagent's tool result, or one
 * from a turn too old to replay — is kept in storage for display and dropped
 * here, and a call whose result is missing is dropped from the assistant message
 * rather than left as an orphan the provider would reject.
 */
export function toEngineMessages(
  messages: ChatMessage[],
  options: ToEngineMessagesOptions = {},
): ChatMessageInput[] {
  const replayTurns = options.toolReplayTurns ?? DEFAULT_TOOL_REPLAY_TURNS;
  const resultByCallId = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "tool" && message.toolCallId) {
      resultByCallId.set(message.toolCallId, message.content);
    }
  }

  const replayable = messages.filter(
    (message): message is AssistantChatMessage =>
      message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0,
  );
  // Newest-first so the budget is spent on the turns a follow-up is most likely
  // about; a call that no longer fits is dropped with its result.
  const replayed = new Map<ChatMessage, Array<{ call: ChannelToolCall; content: string }>>();
  let budget = MAX_REPLAYED_TOOL_CHARS;
  const claimed = new Set<string>();
  // Guarded rather than `slice(-replayTurns)`: `slice(-0)` is `slice(0)`, which
  // would replay everything for the one option value that means "replay none".
  const recent = replayTurns > 0 ? replayable.slice(-replayTurns) : [];
  for (const message of [...recent].reverse()) {
    const pairs: Array<{ call: ChannelToolCall; content: string }> = [];
    for (const call of message.toolCalls ?? []) {
      const id = call.id;
      const content = id ? resultByCallId.get(id) : undefined;
      if (!id || content === undefined || claimed.has(id) || budget <= 0) {
        continue;
      }
      claimed.add(id);
      const kept = content.slice(0, budget);
      budget -= kept.length;
      pairs.push({
        call,
        content: kept.length < content.length ? `${kept}\n…[truncated]` : kept,
      });
    }
    if (pairs.length > 0) {
      replayed.set(message, pairs);
    }
  }

  const out: ChatMessageInput[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      out.push(userMessage(message));
      continue;
    }
    if (message.role === "tool") {
      continue; // emitted with the assistant message that declared it
    }
    const pairs = replayed.get(message) ?? [];
    const mapped: ChatMessageInput = { role: "assistant", content: message.content };
    if (pairs.length > 0) {
      mapped.tool_calls = pairs.map((pair) => pair.call);
    }
    out.push(mapped);
    for (const pair of pairs) {
      out.push({ role: "tool", content: pair.content, tool_call_id: pair.call.id as string });
    }
  }

  return out;
}
