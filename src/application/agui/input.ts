/**
 * What an AG-UI client sends, as the engine reads it.
 *
 * The protocol's messages are OpenAI-shaped under different spellings —
 * `toolCalls` for `tool_calls`, `toolCallId` for `tool_call_id`, a `developer`
 * role beside `system` — and its user turns carry typed content parts where
 * the engine takes `data:` URLs. One mapping, so a run started over AG-UI is
 * the run `/agent` would have started from the same history.
 */

import type { AguiContext, AguiMessage } from "@/domain/agui/types";
import { imageDataUrl, type ChatMessageInput, type ContentPart } from "@/domain/llm/types";

/**
 * The conversation plus what the application asked the run to know.
 *
 * `context` becomes one `system` turn ahead of the history. The protocol
 * defines it as facts the application holds about the session — the page the
 * person is on, the record they have open — which is what a system turn is
 * for, and putting it ahead of the history keeps it out of the turn being
 * answered, where a search query or an image prompt would read it as the
 * request. Empty means no turn at all: nothing is inserted for a client that
 * sent nothing.
 *
 * `activity` and `reasoning` messages are dropped. Both are the client's
 * record of what an earlier run showed it — the reasoning this platform
 * emitted comes back as a `reasoning` message on the next run — and neither is
 * something the model said to the user or the user said to the model.
 */
export function toEngineMessages(
  messages: readonly AguiMessage[],
  context: readonly AguiContext[],
): ChatMessageInput[] {
  const history = messages.flatMap((message) => {
    const mapped = toEngineMessage(message);
    return mapped ? [mapped] : [];
  });
  const contextTurn = contextMessage(context);
  return contextTurn ? [contextTurn, ...history] : history;
}

function contextMessage(context: readonly AguiContext[]): ChatMessageInput | null {
  if (context.length === 0) {
    return null;
  }
  const lines = context.map((entry) => `- ${entry.description}: ${entry.value}`);
  return {
    role: "system",
    content: ["Context provided by the application:", ...lines].join("\n"),
  };
}

function toEngineMessage(message: AguiMessage): ChatMessageInput | null {
  switch (message.role) {
    case "developer":
    case "system":
      return { role: "system", content: message.content };
    case "user":
      return {
        role: "user",
        content:
          typeof message.content === "string" ? message.content : message.content.map(toContentPart),
      };
    case "assistant":
      return {
        role: "assistant",
        content: message.content ?? null,
        ...(message.toolCalls && message.toolCalls.length > 0
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: call.type,
                function: { name: call.function.name, arguments: call.function.arguments },
              })),
            }
          : {}),
      };
    case "tool":
      return {
        role: "tool",
        // The engine's convention for a failed call is an `Error: ` prefix —
        // the trace recorder and the model both read it — so a client that
        // reports one is translated into it rather than handed over as plain
        // text that reads as a success.
        content: message.error ? `Error: ${message.error}` : message.content,
        tool_call_id: message.toolCallId,
      };
    default:
      return null;
  }
}

function toContentPart(part: Extract<AguiMessage, { role: "user" }>["content"][number] & object): ContentPart {
  if (part.type === "text") {
    return { type: "text", text: part.text };
  }
  const url =
    part.source.type === "data"
      ? imageDataUrl({ b64: part.source.value, mimeType: part.source.mimeType })
      : part.source.value;
  return { type: "image_url", image_url: { url } };
}
