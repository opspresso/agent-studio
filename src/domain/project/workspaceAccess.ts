import type { Project, Version } from "./types";
import { activeAgentVersion } from "./activeVersion";

export function projectHasWorkspaceTools(project: Pick<Project, "projectType" | "publishedVersion">, versions: readonly Version[]): boolean {
  return activeAgentVersion(project, versions)?.parameters.workspaceTools === true;
}
