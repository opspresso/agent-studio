import { activeAgentVersion } from "./activeVersion";
import type { Project, Version } from "./types";

/** Project pages follow the published version, or the latest saved draft before publication. */
export function projectHasAudioTools(project: Pick<Project, "projectType" | "publishedVersion">, versions: readonly Version[]): boolean {
  const active = activeAgentVersion(project, versions);
  return active?.parameters.audioProcessing === true;
}
