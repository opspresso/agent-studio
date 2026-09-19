import type { ModelConfig } from "@/domain/llm/models";
import type { ProjectRepository } from "@/domain/project/repository";
import type { Project } from "@/domain/project/types";
import { createProject, type CreateProjectInput } from "./projectUseCases";
import { modelFitsAgent } from "./modelCompatibility";

export interface CreateProjectFlowDeps {
  projects: ProjectRepository;
  offered(): Promise<ModelConfig[]>;
}

/** Create the Agent and its initial current settings in the same row. */
export function composeCreateAgent(deps: CreateProjectFlowDeps): (input: CreateProjectInput) => Promise<Project> {
  return async (input) => {
    const model = (await deps.offered()).find(modelFitsAgent)?.id;
    return createProject(deps.projects, {
      ...input,
      ...(model ? { configuration: {
        systemPrompt: "", model, parameters: { piiFiltering: false },
        mcpList: [], skillList: [], subagentList: [],
      } } : {}),
    });
  };
}
