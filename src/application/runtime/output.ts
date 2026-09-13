import type { EngineChunk } from "@/domain/llm/types";
import { getCurrentSpan } from "@openai/agents";
import type { PiiFilter } from "@/application/llm/pii";
import type { ToolResultBudget } from "@/application/llm/toolResultBudget";

/** Producers pause at event boundaries when their output consumer falls behind. */
export type RuntimeEmitter = ((chunk: EngineChunk) => void) & { ready?: () => Promise<void> };

/** Mask and charge the SDK result, then emit its restored display copy. */
export function writeToolResult(
  call: { id: string; name: string; text: string; bounded?: boolean },
  budget: ToolResultBudget, emit: RuntimeEmitter, filter?: PiiFilter,
): { text: string; truncated: boolean } {
  const masked = filter?.mask(call.text) ?? call.text;
  const text = (call.bounded ? budget.charge : budget.fit)(masked);
  if (text.startsWith("Error:")) getCurrentSpan()?.setError({ message: "Tool execution failed" });
  emit({ toolResult: { toolCallId: call.id, name: call.name, content: filter?.restore(text) ?? text } });
  return { text, truncated: text !== masked };
}
