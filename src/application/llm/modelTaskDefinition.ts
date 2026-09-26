import { MODEL_TASK_TOOL_NAME } from "@/domain/llm/toolNames";
import { CALL_PURPOSES } from "@/domain/llm/callRouting";
import { MAX_IMAGES_PER_TURN } from "@/domain/llm/imageLimits";
import type { ChannelToolDef } from "@/domain/llm/channel";

export const MODEL_TASK_TOOL_DEF: ChannelToolDef = {
  type: "function", function: {
    name: MODEL_TASK_TOOL_NAME,
    description: "Use an additional focused model call only when a cheaper isolated subtask or a capability beyond your own materially helps. Answer greetings, short summaries, routine language tasks and work you can already complete directly; do not delegate merely to restate the user's request or rewrite an answer. Each call adds latency and your own planning and final-answer cost. Your main model stays unchanged. Supply only the context needed for summary, classification, coding, complex reasoning or vision. Classification must return a non-empty JSON object or array. The server enforces model enrollment, budgets, truncation and output-shape checks; these do not verify factual correctness. A null model allows automatic selection; explicit models must belong to the shared tier pool or be your main model. Image ids must refer to images already available in this run.",
    parameters: {
      type: "object", additionalProperties: false,
      properties: {
        purpose: { type: "string", enum: [...CALL_PURPOSES] },
        prompt: { type: "string", minLength: 1, maxLength: 100_000 },
        model: { type: ["string", "null"], maxLength: 200 },
        image_ids: { type: "array", items: { type: "string" }, maxItems: MAX_IMAGES_PER_TURN },
      }, required: ["purpose", "prompt", "model", "image_ids"],
    },
  },
};
