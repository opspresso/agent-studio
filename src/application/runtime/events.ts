import type { RunStreamEvent } from "@openai/agents";
import { isTopLevelChunk } from "@/domain/llm/types";
import type { RuntimeEmitter } from "./output";

/** SDK-generated rejections also produce results when no capability callback ran. */
export function createSdkOutput(destination: RuntimeEmitter) {
  const results = new Set<string>();
  const emit: RuntimeEmitter = (chunk) => {
    if (isTopLevelChunk(chunk) && chunk.toolResult) results.add(chunk.toolResult.toolCallId);
    destination(chunk);
  };
  emit.ready = destination.ready;
  const observe = (event: RunStreamEvent): void => {
    if (event.type !== "run_item_stream_event") return;
    const item = event.item;
    if (item.type === "handoff_output_item") {
      if (!results.has(item.rawItem.callId)) emit({ toolResult: {
        toolCallId: item.rawItem.callId, name: `${item.rawItem.name}: ${item.targetAgent.name}`,
        content: `Conversation handed to ${item.targetAgent.name}.`,
      } });
    } else if (item.type === "tool_call_output_item" && item.rawItem.type === "function_call_result" && !results.has(item.rawItem.callId)) {
      const output = item.rawItem.output;
      let text = typeof output === "string" ? output : Array.isArray(output)
        ? output.filter((part) => part.type === "input_text").map((part) => part.text).join("\n")
        : output.type === "text" ? output.text : "";
      if (item.executionStatus !== "executed" && !text.startsWith("Error:")) text = `Error: ${text}`;
      emit({ toolResult: { toolCallId: item.rawItem.callId, name: item.rawItem.name, content: text } });
    }
  };
  return { emit, observe };
}
