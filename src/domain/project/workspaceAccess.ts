import type { Project } from "./types";

export function projectHasWorkspaceTools(project: Pick<Project, "configuration">): boolean {
  return project.configuration?.parameters.workspaceTools === true;
}
