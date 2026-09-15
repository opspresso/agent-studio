import type { Project, Version } from "./types";

/** Tabs and project tools use the published version, or the latest saved draft. */
export function activeAgentVersion(project: Pick<Project, "projectType" | "publishedVersion">, versions: readonly Version[]): Version | undefined {
  if (project.projectType !== "agent") return undefined;
  const active = project.publishedVersion
    ? versions.find((version) => version.versionName === project.publishedVersion)
    : [...versions].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  return active;
}
