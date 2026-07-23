import type { ProjectRepository, VersionRepository } from "@/domain/project/repository";
import type { Project, SubagentRef, Version, VersionParameters } from "@/domain/project/types";
import { getModelConfig } from "@/domain/llm/models";
import { ConflictError, NotFoundError, ValidationError } from "@/application/errors";
import { assertProjectOwner } from "./projectUseCases";

export interface VersionInput {
  systemPrompt: string;
  userPromptTemplate: string;
  model: string;
  fallbackModel?: string;
  parameters: VersionParameters;
  mcpList: string[];
  skillList: string[];
  subagentList: SubagentRef[];
  maxTurn?: number;
}

export interface CreateVersionInput extends VersionInput {
  /** Optional explicit name; auto-incremented numeric name when omitted. */
  versionName?: string;
}

export type UpdateVersionInput = Partial<VersionInput>;

/** Reject an imageModel that is unknown or lacks the imageGeneration capability. */
function assertValidImageModel(parameters: VersionParameters): void {
  if (parameters.imageModel && !getModelConfig(parameters.imageModel)?.capabilities.imageGeneration) {
    throw new ValidationError(`Model does not support image generation: ${parameters.imageModel}`);
  }
}

/** Warn (non-blocking) when a version references a model missing from the catalog. */
function warnUnknownCatalogModel(projectName: string, model: string): void {
  if (!getModelConfig(model)) {
    console.warn(
      `[version] ${projectName}: model "${model}" is not in the catalog; usage will be recorded with $0 cost`,
    );
  }
}

function nextVersionName(existing: Version[]): string {
  const maxNumeric = existing.reduce((max, version) => {
    const parsed = Number(version.versionName);
    return Number.isInteger(parsed) && parsed > max ? parsed : max;
  }, 0);
  return String(maxNumeric + 1);
}

export function listVersions(repo: VersionRepository, projectName: string): Promise<Version[]> {
  return repo.list(projectName);
}

export async function getVersion(
  repo: VersionRepository,
  projectName: string,
  versionName: string,
): Promise<Version> {
  const version = await repo.get(projectName, versionName);
  if (!version) {
    throw new NotFoundError(`Version "${versionName}" not found in project "${projectName}"`);
  }
  return version;
}

export async function createVersion(
  versions: VersionRepository,
  projects: ProjectRepository,
  projectName: string,
  input: CreateVersionInput,
  userEmail: string,
): Promise<Version> {
  await assertProjectOwner(projects, projectName, userEmail);
  assertValidImageModel(input.parameters);
  warnUnknownCatalogModel(projectName, input.model);
  const existing = await versions.list(projectName);

  const versionName = input.versionName ?? nextVersionName(existing);
  if (existing.some((version) => version.versionName === versionName)) {
    throw new ConflictError(`Version "${versionName}" already exists in project "${projectName}"`);
  }

  const version: Version = {
    projectName,
    versionName,
    systemPrompt: input.systemPrompt,
    userPromptTemplate: input.userPromptTemplate,
    model: input.model,
    fallbackModel: input.fallbackModel,
    parameters: input.parameters,
    mcpList: input.mcpList,
    skillList: input.skillList,
    subagentList: input.subagentList,
    maxTurn: input.maxTurn,
    createdAt: new Date().toISOString(),
  };
  await versions.put(version);
  return version;
}

export async function updateVersion(
  versions: VersionRepository,
  projects: ProjectRepository,
  projectName: string,
  versionName: string,
  input: UpdateVersionInput,
  userEmail: string,
): Promise<Version> {
  await assertProjectOwner(projects, projectName, userEmail);
  if (input.parameters) {
    assertValidImageModel(input.parameters);
  }
  if (input.model !== undefined) {
    warnUnknownCatalogModel(projectName, input.model);
  }
  const existing = await getVersion(versions, projectName, versionName);
  const updated: Version = {
    ...existing,
    systemPrompt: input.systemPrompt ?? existing.systemPrompt,
    userPromptTemplate: input.userPromptTemplate ?? existing.userPromptTemplate,
    model: input.model ?? existing.model,
    fallbackModel: input.fallbackModel ?? existing.fallbackModel,
    parameters: input.parameters ?? existing.parameters,
    mcpList: input.mcpList ?? existing.mcpList,
    skillList: input.skillList ?? existing.skillList,
    subagentList: input.subagentList ?? existing.subagentList,
    maxTurn: input.maxTurn ?? existing.maxTurn,
  };
  await versions.put(updated);
  return updated;
}

export async function deleteVersion(
  versions: VersionRepository,
  projects: ProjectRepository,
  projectName: string,
  versionName: string,
  userEmail: string,
): Promise<void> {
  await assertProjectOwner(projects, projectName, userEmail);
  await getVersion(versions, projectName, versionName);
  await versions.delete(projectName, versionName);
}

/** Point the project's published pointer at an existing version. */
export async function publishVersion(
  projects: ProjectRepository,
  versions: VersionRepository,
  projectName: string,
  versionName: string,
  userEmail: string,
): Promise<Project> {
  const project = await assertProjectOwner(projects, projectName, userEmail);
  await getVersion(versions, projectName, versionName);

  const updated: Project = {
    ...project,
    publishedVersion: versionName,
    updatedAt: new Date().toISOString(),
  };
  await projects.update(updated);
  return updated;
}
