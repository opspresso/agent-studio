/**
 * What an AG-UI client sends, as the engine reads it.
 *
 * The protocol's messages are OpenAI-shaped under different spellings —
 * `toolCalls` for `tool_calls`, `toolCallId` for `tool_call_id`, a `developer`
 * role beside `system` — and its user turns carry typed content parts where
 * the engine takes `data:` URLs. One mapping, so a run started over AG-UI is
 * the run `/agent` would have started from the same history.
 */

import type { AguiContext, AguiInputContent, AguiMessage } from "@/domain/agui/types";
import type { DocumentExtractor } from "@/domain/llm/documentExtractor";
import { imageDataUrl, type ChatMessageInput, type ContentPart } from "@/domain/llm/types";
import {
  readDocuments,
  turnContent,
  type AttachedDocument,
} from "@/application/llm/documentParts";

export interface AguiInputDeps {
  /** Turns a document part into text, the way every other surface's attachment becomes text. */
  documents: DocumentExtractor;
  /** What reading the input lost — an unreadable file, a budget spent — for the surface to report. */
  warnings: string[];
}

/**
 * The most of the application's `state` the prompt carries. A cap we chose,
 * beside the mechanism that spends it: the state is the application's own
 * object, unbounded by the protocol, and it enters the context once per run.
 */
const MAX_STATE_CHARS = 20_000;

/**
 * The conversation plus what the application asked the run to know.
 *
 * A `reasoning` message is the client's record of the thinking this platform
 * streamed before an assistant turn, and it goes back onto that turn as
 * `reasoning_content` — the engine keeps a turn's thinking attached to the
 * turn that produced it and to the tool calls it declared, and the turn a
 * client-tool call ended on is exactly the one the next run replays. One that
 * precedes nothing of the assistant's is dropped; so is an `activity`
 * message, which records what an earlier run showed rather than what was said.
 *
 * `context` and `state` become one `system` turn ahead of the history. The
 * protocol defines context as facts the application holds about the session
 * — the page the person is on, the record they have open — and state as the
 * object the application shares with the agent; both are what a system turn
 * is for, and putting them ahead of the history keeps them out of the turn
 * being answered, where a search query or an image prompt would read them as
 * the request. The state is read-only here — no `STATE_SNAPSHOT` ever goes
 * back — and the turn says so, because a model told it can change a thing it
 * cannot will claim to have. Empty means no turn at all.
 *
 * A `document` part is read at this surface, through the same extractor and
 * budgets as a chat attachment, and its text leads the turn the way it does
 * there (`turnContent` owns the order). What could not be read is a warning,
 * never a silent absence.
 */
export async function toEngineMessages(
  messages: readonly AguiMessage[],
  context: readonly AguiContext[],
  state: unknown,
  deps: AguiInputDeps,
): Promise<ChatMessageInput[]> {
  const history: ChatMessageInput[] = [];
  let pendingReasoning: string | undefined;
  for (const message of messages) {
    if (message.role === "reasoning") {
      pendingReasoning = pendingReasoning ? `${pendingReasoning}\n\n${message.content}` : message.content;
      continue;
    }
    const mapped = await toEngineMessage(message, deps);
    if (mapped) {
      history.push(
        mapped.role === "assistant" && pendingReasoning
          ? { ...mapped, reasoning_content: pendingReasoning }
          : mapped,
      );
    }
    pendingReasoning = undefined;
  }
  const contextTurn = contextMessage(context, state);
  return contextTurn ? [contextTurn, ...history] : history;
}

function contextMessage(context: readonly AguiContext[], state: unknown): ChatMessageInput | null {
  const sections: string[] = [];
  if (context.length > 0) {
    sections.push(
      ["Context provided by the application:", ...context.map((entry) => `- ${entry.description}: ${entry.value}`)].join(
        "\n",
      ),
    );
  }
  const stateText = stateJson(state);
  if (stateText !== undefined) {
    sections.push(
      [
        "Application state, shared with you read-only — you cannot change it, so do not claim to have:",
        "```json",
        stateText,
        "```",
      ].join("\n"),
    );
  }
  if (sections.length === 0) {
    return null;
  }
  return { role: "system", content: sections.join("\n\n") };
}

/** The state as JSON, or nothing for an absent or empty one. Bounded, with the cut named. */
function stateJson(state: unknown): string | undefined {
  if (state === undefined || state === null) {
    return undefined;
  }
  if (typeof state === "object" && Object.keys(state as object).length === 0) {
    return undefined;
  }
  let text: string;
  try {
    text = JSON.stringify(state, null, 2) ?? "";
  } catch {
    return undefined;
  }
  if (!text) {
    return undefined;
  }
  return text.length > MAX_STATE_CHARS
    ? `${text.slice(0, MAX_STATE_CHARS)}\n…[state truncated at ${MAX_STATE_CHARS} characters]`
    : text;
}

async function toEngineMessage(
  message: Exclude<AguiMessage, { role: "reasoning" }>,
  deps: AguiInputDeps,
): Promise<ChatMessageInput | null> {
  switch (message.role) {
    case "developer":
    case "system":
      return { role: "system", content: message.content };
    case "user":
      return {
        role: "user",
        content:
          typeof message.content === "string" ? message.content : await userContent(message.content, deps),
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

/**
 * A user turn's parts as the engine takes them: documents read to text and
 * leading, then the text, then the images — `turnContent`'s order, so a turn
 * that arrived over AG-UI reads like one that arrived in a chat.
 */
async function userContent(
  parts: readonly AguiInputContent[],
  deps: AguiInputDeps,
): Promise<string | ContentPart[]> {
  const text = parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n\n");
  const images: ContentPart[] = parts.flatMap((part) =>
    part.type === "image"
      ? [
          {
            type: "image_url" as const,
            image_url: {
              url:
                part.source.type === "data"
                  ? imageDataUrl({ b64: part.source.value, mimeType: part.source.mimeType })
                  : part.source.value,
            },
          },
        ]
      : [],
  );
  const attached: AttachedDocument[] = parts.flatMap((part, index) =>
    part.type === "document"
      ? [
          {
            bytes: Buffer.from(part.source.value, "base64"),
            mimeType: part.source.mimeType,
            name: documentName(part.metadata, part.source.mimeType, index),
          },
        ]
      : [],
  );
  const documents = await readDocuments(deps.documents, attached, deps.warnings);
  return turnContent(documents, text, images);
}

/**
 * What to call a document the protocol leaves unnamed. `metadata` is open, and
 * the two spellings an application is likely to use are read; otherwise the
 * media type's own subtype, so the extractor and the model see *a* name.
 */
function documentName(metadata: Record<string, unknown> | undefined, mimeType: string, index: number): string {
  for (const key of ["name", "filename"]) {
    const value = metadata?.[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  const subtype = mimeType.split("/")[1]?.split(";")[0]?.trim() || "bin";
  return `document-${index + 1}.${subtype}`;
}
