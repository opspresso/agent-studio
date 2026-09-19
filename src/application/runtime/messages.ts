import type { AgentInputItem } from "@openai/agents";
import type { ChannelMessage } from "@/domain/llm/channel";
import { ValidationError } from "@/application/errors";
import { PiiFilter } from "@/application/llm/pii";

/** Translate the public Chat Completions input into the SDK's native history. */
export function toAgentInput(messages: ChannelMessage[]): AgentInputItem[] {
  return messages.flatMap((message): AgentInputItem[] => {
    const text = typeof message.content === "string" ? message.content : "";
    if (message.role === "tool") {
      if (!message.tool_call_id) throw new ValidationError("A tool result requires tool_call_id");
      return [{ type: "function_call_result", status: "completed", name: message.name ?? "tool", callId: message.tool_call_id, output: text }];
    }
    if (message.role === "system") return [{ type: "message", role: "system", content: text }];
    if (message.role === "user") return [{
      type: "message", role: "user", content: Array.isArray(message.content)
        ? message.content.map((part) => part.type === "text"
          ? { type: "input_text" as const, text: part.text }
          : { type: "input_image" as const, image: part.image_url.url, detail: part.image_url.detail ?? "auto" })
        : text,
    }];
    const result: AgentInputItem[] = [{
      type: "message", role: "assistant", status: "completed",
      content: Array.isArray(message.content)
        ? message.content.map((part) => part.type === "text"
          ? { type: "output_text" as const, text: part.text }
          : { type: "image" as const, image: part.image_url.url })
        : (text ? [{ type: "output_text", text }] : []),
      ...(message.reasoning_content ? { providerData: { reasoning_content: message.reasoning_content } } : {}),
    }];
    for (const call of message.tool_calls ?? []) {
      if (!call.id || !call.function?.name) throw new ValidationError("A tool call requires an id and function name");
      result.push({ type: "function_call", callId: call.id, name: call.function.name, arguments: call.function.arguments ?? "{}" });
    }
    return result;
  });
}

/** Bounded delegation transcripts read native Session/model history, never UI rows. */
export function conversationMessages(items: AgentInputItem[]): ChannelMessage[] {
  return items.flatMap((item): ChannelMessage[] => {
    if (!((item.type === "message" || item.type === undefined) && (item.role === "user" || item.role === "assistant"))) return [];
    const text = typeof item.content === "string" ? item.content : item.content.map((part) => {
      if ("text" in part && typeof part.text === "string") return part.text;
      return part.type === "input_image" || part.type === "image" ? "[image]" : "";
    }).filter(Boolean).join("\n");
    return text ? [{ role: item.role, content: text }] : [];
  });
}

const OPAQUE_KEYS = new Set(["image_url", "image"]);

export function maskValues(filter: PiiFilter, value: unknown): unknown {
  if (typeof value === "string") {
    return filter.mask(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => maskValues(filter, item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        OPAQUE_KEYS.has(key) ? item : maskValues(filter, item),
      ]),
    );
  }
  return value;
}

export function maskMessage(filter: PiiFilter, message: ChannelMessage): ChannelMessage {
  return maskValues(filter, message) as ChannelMessage;
}

export function restoreValues(filter: PiiFilter, value: unknown): unknown {
  if (typeof value === "string") {
    return filter.restore(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => restoreValues(filter, item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        OPAQUE_KEYS.has(key) ? item : restoreValues(filter, item),
      ]),
    );
  }
  return value;
}
