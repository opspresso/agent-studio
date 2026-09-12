import type { InputGuardrail } from "@openai/agents";
import type { RuntimePolicy } from "@/domain/execution/runtimeSession";
import { messageText, type ChatMessageInput } from "@/domain/llm/types";

export function inputGuardrails(messages: ChatMessageInput[], policy?: RuntimePolicy): InputGuardrail[] {
  const limit = policy?.maxInputChars;
  if (!limit) return [];
  return [{ name: "input-size", runInParallel: false, execute: async () => ({
    tripwireTriggered: messages.reduce((size, message) => size + messageText(message).length, 0) > limit,
    outputInfo: { reason: "Input exceeds the version's policy limit" },
  }) }];
}
