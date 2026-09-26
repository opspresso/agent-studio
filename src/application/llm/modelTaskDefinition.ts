import { MODEL_TASK_TOOL_NAME } from "@/domain/llm/toolNames";
import { CALL_PURPOSES } from "@/domain/llm/callRouting";
import { MAX_IMAGES_PER_TURN } from "@/domain/llm/imageLimits";
import type { ChannelToolDef } from "@/domain/llm/channel";

export const MODEL_TASK_TOOL_DEF: ChannelToolDef = {
  type: "function", function: {
    name: MODEL_TASK_TOOL_NAME,
    description: "Use an additional focused call when a cheaper isolated subtask or stronger reasoning/vision helps, or the user requests a different model. Answer greetings, short summaries and routine work directly; do not delegate merely to rewrite an answer. Each call adds planning, inference and final-answer cost. Supply only needed context. Classification must return a non-empty JSON object or array. Use model:null for automatic selection; never invent model ids. Explicit ids must belong to the shared tier pool or be your main model. When the user asks for a different model, set require_different_model:true; the server then forbids your main registered model, including fallback. Image ids must exist in this run. Budget and output-shape checks do not verify factual accuracy.",
    parameters: {
      type: "object", additionalProperties: false,
      properties: {
        purpose: { type: "string", enum: [...CALL_PURPOSES] },
        prompt: { type: "string", minLength: 1, maxLength: 100_000 },
        model: { type: ["string", "null"], maxLength: 200 },
        require_different_model: { type: "boolean" },
        image_ids: { type: "array", items: { type: "string" }, maxItems: MAX_IMAGES_PER_TURN },
      }, required: ["purpose", "prompt", "model", "image_ids"],
    },
  },
};
