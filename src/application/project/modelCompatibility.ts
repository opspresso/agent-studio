import { modelType, type ModelConfig } from "@/domain/llm/models";
import type { ProjectType } from "@/domain/project/types";

const REQUIRED_MODEL_TYPE = {
  image: "image",
  agent: "text",
  llm: "text",
} as const;

const REQUIRES_TOOLS: Record<ProjectType, boolean> = {
  image: false,
  agent: true,
  llm: false,
};

export type ModelCompatibilityRejectReason = "type" | "tools";

/** Why a catalog model cannot execute one project type, or null when it can. */
export function modelCompatibilityRejectReason(
  projectType: ProjectType,
  model: ModelConfig,
): ModelCompatibilityRejectReason | null {
  if (modelType(model) !== REQUIRED_MODEL_TYPE[projectType]) return "type";
  if (REQUIRES_TOOLS[projectType] && !model.capabilities.tools) return "tools";
  return null;
}

/** Whether a catalog model can execute one project type. */
export function modelFitsProjectType(projectType: ProjectType, model: ModelConfig): boolean {
  return modelCompatibilityRejectReason(projectType, model) === null;
}
