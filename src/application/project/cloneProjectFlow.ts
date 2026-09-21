import type { Project } from "@/domain/project/types";
import type { ConfigurationDeps } from "./configurationUseCases";
import { putAgentConfiguration } from "./configurationUseCases";
import { assertProjectAccessible, createProject } from "./projectUseCases";
import { log } from "@/shared/logger";

export type CloneProjectFlowDeps = ConfigurationDeps;
export interface CloneProjectInput {
  sourceName: string;
  name: string;
  displayName: string;
  userEmail: string;
}
export interface CloneProjectResult { project: Project; warning?: string }

/** Copy current settings while keeping credentials and membership with their owner. */
export function composeCloneProject(deps: CloneProjectFlowDeps): (input: CloneProjectInput) => Promise<CloneProjectResult> {
  return async (input) => {
    const source = await assertProjectAccessible(deps.projects, input.sourceName, input.userEmail);
    const project = await createProject(deps.projects, {
      name: input.name, displayName: input.displayName, description: source.description,
      ownerEmail: input.userEmail, departmentCode: source.departmentCode, visibility: source.visibility,
    });
    if (!source.configuration) return { project };
    try {
      await putAgentConfiguration(deps, project.name, {
        ...source.configuration,
        mcpList: source.configuration.mcpList.map(({ headers: _headers, headerTarget: _target, ...binding }) => binding),
        expectedUpdatedAt: project.updatedAt,
      }, input.userEmail);
      return { project: (await deps.projects.get(project.name))! };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      log.warn("project", `configuration could not be copied to "${project.name}"`, error);
      return { project, warning: `The Agent configuration could not be copied (${reason}); configure the clone before running it.` };
    }
  };
}
