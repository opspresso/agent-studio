import type { Project, Version } from "@/domain/project/types";
import type { ProjectRepository, VersionRepository } from "@/domain/project/repository";
import type { AudioJobConfigRepository } from "@/domain/audio/config";
import { getModelConfig } from "@/domain/llm/models";
import { ConflictError, ValidationError } from "@/application/errors";

/** Resolve aliases at submission; the job keeps the concrete version snapshot. */
export async function resolveAudioPostprocessor(
  versions: Pick<VersionRepository, "get">,
  authorize: (name: string, email: string) => Promise<Project>,
  reference: { projectName: string; versionName: string },
  email: string,
) {
  const project = await authorize(reference.projectName, email);
  if (project.projectType !== "agent") {
    throw new ValidationError(`Postprocessing requires an Agent project: ${project.name}`);
  }
  const version = await versions.get(project.name, reference.versionName);
  if (!version) {
    throw new ValidationError(`Postprocessing version "${project.name}/${reference.versionName}" was not found. Select an existing version or "published".`);
  }
  if (!getModelConfig(version.model)?.capabilities.structuredOutput) {
    throw new ValidationError(`Postprocessing model "${version.model}" does not support structured output`);
  }
  return { projectName: project.name, versionName: version.versionName, version };
}

const CONFIG_REFERENCE_PAGE_SIZE = 100;

/** Enabled recipes must not be left pointing at a deleted fixed version. */
export async function assertAudioPostprocessorVersionUnused(
  deps: { projects: Pick<ProjectRepository, "list">; configs: Pick<AudioJobConfigRepository, "get"> },
  project: Project,
  version: Version,
): Promise<void> {
  let after: string | undefined;
  do {
    const projects = await deps.projects.list(CONFIG_REFERENCE_PAGE_SIZE, after);
    for (const candidate of projects) {
      // A postprocessor and its caller must have the same owner.
      if (candidate.ownerEmail !== project.ownerEmail) continue;
      const config = await deps.configs.get(candidate.name);
      if (config?.enabled && config.postprocess?.projectName === project.name &&
        config.postprocess.versionName === version.versionName) {
        throw new ConflictError(`Audio configuration for "${candidate.name}" uses version "${project.name}/${version.versionName}". Change its postprocessor to another version or "published" before deleting it.`);
      }
    }
    if (projects.length < CONFIG_REFERENCE_PAGE_SIZE) return;
    after = projects.at(-1)!.name;
  } while (true);
}
