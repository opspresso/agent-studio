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

/** Whether a catalog model can execute one project type. */
export function modelFitsProjectType(projectType: ProjectType, model: ModelConfig): boolean {
  return (
    modelType(model) === REQUIRED_MODEL_TYPE[projectType] &&
    (!REQUIRES_TOOLS[projectType] || model.capabilities.tools)
  );
}
