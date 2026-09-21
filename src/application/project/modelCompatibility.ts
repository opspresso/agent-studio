import { modelType, type ModelConfig } from "@/domain/llm/models";

export type ModelCompatibilityRejectReason = "type" | "tools";

/** Why a catalog model cannot execute an Agent, or null when it can. */
export function agentModelRejectReason(
  model: ModelConfig,
): ModelCompatibilityRejectReason | null {
  if (!["text", "decisions"].includes(modelType(model))) return "type";
  if (!model.capabilities.tools) return "tools";
  return null;
}

/** Whether a catalog model can execute an Agent. */
export function modelFitsAgent(model: ModelConfig): boolean {
  return agentModelRejectReason(model) === null;
}
