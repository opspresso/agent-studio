import { MODEL_TASK_TOOL_NAME } from "@/domain/llm/toolNames";
import { CALL_PURPOSES } from "@/domain/llm/callRouting";
import { MAX_IMAGES_PER_TURN } from "@/domain/llm/imageLimits";
import type { ChannelToolDef } from "@/domain/llm/channel";

export const MODEL_TASK_TOOL_DEF: ChannelToolDef = {
  type: "function", function: {
    name: MODEL_TASK_TOOL_NAME,
    description: "Make one focused model call for summary, classification, coding, complex reasoning or vision, then use its result in your answer. Your main model stays unchanged. Supply only the context needed for this task. Classification must return a JSON object or array. Model routing, budgets and quality checks are enforced by the server. A null model allows automatic selection; explicit models must be configured for this Agent. Image ids must refer to images already available in this run.",
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
