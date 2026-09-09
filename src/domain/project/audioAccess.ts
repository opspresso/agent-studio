import type { Project, Version } from "./types";

/** Project pages follow the published version, or the latest saved draft before publication. */
export function projectHasAudioTools(project: Pick<Project, "projectType" | "publishedVersion">, versions: readonly Version[]): boolean {
  if (project.projectType !== "agent") return false;
  const active = project.publishedVersion
    ? versions.find((version) => version.versionName === project.publishedVersion)
    : [...versions].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  return active?.parameters.audioProcessing === true;
}
