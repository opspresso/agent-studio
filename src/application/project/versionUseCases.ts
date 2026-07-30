import type { ProjectRepository, VersionRepository } from "@/domain/project/repository";
import type {
  McpBinding,
  Project,
  SubagentRef,
  Version,
  VersionParameters,
} from "@/domain/project/types";
import type { SecretCipher } from "@/domain/security/secretCipher";
import type { SkillRepository } from "@/domain/skill/repository";
import type { McpRepository } from "@/domain/mcp/repository";
import type { ExternalAgentRepository } from "@/domain/agent/repository";
import { getModelConfig } from "@/domain/llm/models";
import { ConflictError, NotFoundError, ValidationError, isConditionalWriteFailure, isTransactionCancelled } from "@/application/errors";
import { assertProjectWritable } from "./projectUseCases";
import { nextUpdatedAt } from "./timestamps";
import { log } from "@/shared/logger";

/**
 * Registry lookups a version's references are checked against. A dangling
 * reference degrades silently at run time (an unknown skill loads as an empty
 * description, an unknown subagent yields a tool error), so a typo would only
 * surface as a subtly worse answer — catch it at the write boundary instead.
 */
export interface VersionRefRepos {
  skills: Pick<SkillRepository, "get">;
  mcps: Pick<McpRepository, "get">;
  externalAgents: Pick<ExternalAgentRepository, "get">;
  /** Local subagents are other projects. */
  projects: Pick<ProjectRepository, "get">;
}

/** The reference lists as they appear on a version. */
interface VersionRefs {
  mcpList?: McpBinding[];
  skillList?: string[];
  subagentList?: SubagentRef[];
}

const subagentKey = (ref: SubagentRef): string => `${ref.type}:${ref.name}`;

/**
 * What the version already referenced. Both checks below look only at what an
 * edit *adds*, so a version stays editable after the world around it changed.
 */
function alreadyReferenced(existing?: VersionRefs) {
  return {
    mcps: new Set((existing?.mcpList ?? []).map((binding) => binding.name)),
    skills: new Set(existing?.skillList ?? []),
    subagents: new Set((existing?.subagentList ?? []).map(subagentKey)),
  };
}

/**
 * Reject tool bindings on a project type that cannot run them. Only agent
 * projects run the tool loop — `executeProjectStream` sends every other type to
 * a single-shot completion that offers no tools — so a binding stored on one of
 * them is accepted, displayed, and then silently ignored at run time. Project
 * type is fixed at creation, so this can never become true later.
 */
function assertToolBindingsRunnable(
  project: Project,
  next: VersionRefs,
  existing?: VersionRefs,
): void {
  if (project.projectType === "agent") {
    return;
  }
  const known = alreadyReferenced(existing);
  const added = [
    ...(next.mcpList ?? [])
      .filter((binding) => !known.mcps.has(binding.name))
      .map((binding) => `MCP server "${binding.name}"`),
    ...(next.skillList ?? []).filter((name) => !known.skills.has(name)).map((name) => `skill "${name}"`),
    ...(next.subagentList ?? [])
      .filter((ref) => !known.subagents.has(subagentKey(ref)))
      .map((ref) => `agent "${ref.name}"`),
  ];
  if (added.length > 0) {
    throw new ValidationError(
      `A "${project.projectType}" project does not run tools, so ${added.join(", ")} would never be used. Only agent projects can use MCP servers, skills and subagents.`,
    );
  }
}

function assertUniqueSubagentNames(subagents: SubagentRef[] | undefined): void {
  const seen = new Set<string>();
  const duplicate = (subagents ?? []).find((ref) => {
    if (seen.has(ref.name)) {
      return true;
    }
    seen.add(ref.name);
    return false;
  });
  if (duplicate) {
    throw new ValidationError(
      `Agent name "${duplicate.name}" is used more than once; connected agents must have unique names.`,
    );
  }
}

/**
 * Reject references that do not resolve. Only entries absent from `existing`
 * are checked: a version whose skill or MCP server was deleted afterwards must
 * still be editable, otherwise deleting a registry entry would strand every
 * version that ever used it.
 */
async function assertReferencesExist(
  refs: VersionRefRepos,
  next: VersionRefs,
  existing?: VersionRefs,
): Promise<void> {
  const { mcps: knownMcps, skills: knownSkills, subagents: knownSubagents } =
    alreadyReferenced(existing);

  const checks: Array<Promise<string | null>> = [
    ...(next.mcpList ?? [])
      .filter((binding) => !knownMcps.has(binding.name))
      .map(async ({ name }) =>
        (await refs.mcps.get(name)) ? null : `MCP server "${name}" does not exist`,
      ),
    ...(next.skillList ?? [])
      .filter((name) => !knownSkills.has(name))
      .map(async (name) =>
        (await refs.skills.get(name)) ? null : `Skill "${name}" does not exist`,
      ),
    ...(next.subagentList ?? [])
      .filter((ref) => !knownSubagents.has(subagentKey(ref)))
      .map(async (ref) => {
        const found =
          ref.type === "remote"
            ? await refs.externalAgents.get(ref.name)
            : await refs.projects.get(ref.name);
        return found ? null : `${ref.type === "remote" ? "Agent" : "Project"} "${ref.name}" does not exist`;
      }),
  ];

  const missing = (await Promise.all(checks)).filter((message): message is string => message !== null);
  if (missing.length > 0) {
    throw new ValidationError(missing.join("; "));
  }
}

export interface VersionInput {
  systemPrompt: string;
  userPromptTemplate: string;
  model: string;
  fallbackModel?: string;
  parameters: VersionParameters;
  mcpList: McpBinding[];
  skillList: string[];
  subagentList: SubagentRef[];
  maxTurn?: number;
}

/**
 * Resolve submitted MCP bindings to their stored form: header override values
 * are encrypted at rest, and a masked or empty value keeps the secret already
 * stored under the same server and header name. A binding with no overrides is
 * stored without the field, so an untouched version is byte-identical to what
 * it was before overrides existed.
 */
function resolveMcpBindings(
  cipher: SecretCipher,
  next: McpBinding[],
  existing: McpBinding[] = [],
): McpBinding[] {
  const storedByName = new Map(existing.map((binding) => [binding.name, binding.headers ?? {}]));
  return next.map((binding) => {
    if (!binding.headers || Object.keys(binding.headers).length === 0) {
      return { name: binding.name };
    }
    const headers = cipher.mergeHeaderOverrideUpdate(
      storedByName.get(binding.name) ?? {},
      binding.headers,
    );
    return Object.keys(headers).length > 0
      ? { name: binding.name, headers }
      : { name: binding.name };
  });
}

/**
 * A version as an API response may carry it. Versions hold secrets now that MCP
 * bindings can override headers, so every route that returns one masks it here.
 * Execution paths deliberately do NOT: they read the repository value and
 * decrypt at dispatch.
 */
export function toVersionView(cipher: SecretCipher, version: Version): Version {
  return {
    ...version,
    mcpList: version.mcpList.map((binding) =>
      binding.headers
        ? { name: binding.name, headers: cipher.maskHeaderOverrides(binding.headers) }
        : binding,
    ),
  };
}

export interface CreateVersionInput extends VersionInput {
  /** Optional explicit name; auto-incremented numeric name when omitted. */
  versionName?: string;
}

export type UpdateVersionInput = Partial<Omit<VersionInput, "fallbackModel" | "maxTurn">> & {
  fallbackModel?: string | null;
  maxTurn?: number | null;
};

/** Reject an imageModel that is unknown or lacks the imageGeneration capability. */
function assertValidImageModel(parameters: VersionParameters): void {
  if (parameters.imageModel && !getModelConfig(parameters.imageModel)?.capabilities.imageGeneration) {
    throw new ValidationError(`Model does not support image generation: ${parameters.imageModel}`);
  }
}

/** Warn (non-blocking) when a version references a model missing from the catalog. */
function warnUnknownCatalogModel(projectName: string, model: string): void {
  if (!getModelConfig(model)) {
    log.warn(
      "version",
      `${projectName}: model "${model}" is not in the catalog; usage will be recorded with $0 cost`,
    );
  }
}

/**
 * Reject capability mismatches for catalog models. Unknown/custom ids stay on
 * the warn-only path — a mismatch on a KNOWN model is a misconfiguration, not
 * a catalog lag.
 */
function assertModelSupports(project: Project, model: string, parameters: VersionParameters): void {
  const cfg = getModelConfig(model);
  if (!cfg) {
    return;
  }
  if (project.projectType === "agent" && !cfg.capabilities.tools) {
    throw new ValidationError(
      `Model does not support tool calling required by agent projects: ${model}`,
    );
  }
  if (parameters.structuredOutput && !cfg.capabilities.structuredOutput) {
    throw new ValidationError(`Model does not support structured output: ${model}`);
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
  refs: VersionRefRepos,
  cipher: SecretCipher,
): Promise<Version> {
  const project = await assertProjectWritable(projects, projectName, userEmail);
  assertValidImageModel(input.parameters);
  assertModelSupports(project, input.model, input.parameters);
  warnUnknownCatalogModel(projectName, input.model);
  assertToolBindingsRunnable(project, input);
  assertUniqueSubagentNames(input.subagentList);
  await assertReferencesExist(refs, input);
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
    mcpList: resolveMcpBindings(cipher, input.mcpList),
    skillList: input.skillList,
    subagentList: input.subagentList,
    maxTurn: input.maxTurn,
    createdAt: new Date().toISOString(),
  };
  try {
    await versions.create(version);
  } catch (error) {
    if (isConditionalWriteFailure(error, { includeTransaction: true })) {
      throw new ConflictError(`Version "${versionName}" already exists in project "${projectName}"`);
    }
    throw error;
  }
  return version;
}

export async function updateVersion(
  versions: VersionRepository,
  projects: ProjectRepository,
  projectName: string,
  versionName: string,
  input: UpdateVersionInput,
  userEmail: string,
  refs: VersionRefRepos,
  cipher: SecretCipher,
): Promise<Version> {
  const project = await assertProjectWritable(projects, projectName, userEmail);
  if (input.parameters) {
    assertValidImageModel(input.parameters);
  }
  if (input.model !== undefined) {
    warnUnknownCatalogModel(projectName, input.model);
  }
  const existing = await getVersion(versions, projectName, versionName);
  assertToolBindingsRunnable(project, input, existing);
  if (input.subagentList) {
    assertUniqueSubagentNames(input.subagentList);
  }
  await assertReferencesExist(refs, input, existing);
  const updated: Version = {
    ...existing,
    systemPrompt: input.systemPrompt ?? existing.systemPrompt,
    userPromptTemplate: input.userPromptTemplate ?? existing.userPromptTemplate,
    model: input.model ?? existing.model,
    fallbackModel:
      input.fallbackModel === null ? undefined : input.fallbackModel ?? existing.fallbackModel,
    parameters: input.parameters ?? existing.parameters,
    mcpList: input.mcpList
      ? resolveMcpBindings(cipher, input.mcpList, existing.mcpList)
      : existing.mcpList,
    skillList: input.skillList ?? existing.skillList,
    subagentList: input.subagentList ?? existing.subagentList,
    maxTurn: input.maxTurn === null ? undefined : input.maxTurn ?? existing.maxTurn,
  };
  assertModelSupports(project, updated.model, updated.parameters);
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
  const project = await assertProjectWritable(projects, projectName, userEmail);
  await getVersion(versions, projectName, versionName);
  if (project.publishedVersion === versionName) {
    throw new ConflictError(`Published version "${versionName}" cannot be deleted`);
  }
  try {
    await versions.delete(projectName, versionName, project.updatedAt);
  } catch (error) {
    if (isTransactionCancelled(error)) {
      throw new ConflictError(`Version "${versionName}" changed while it was being deleted`);
    }
    throw error;
  }
}

/** Point the project's published pointer at an existing version. */
export async function publishVersion(
  projects: ProjectRepository,
  versions: VersionRepository,
  projectName: string,
  versionName: string,
  userEmail: string,
): Promise<Project> {
  const project = await assertProjectWritable(projects, projectName, userEmail);
  await getVersion(versions, projectName, versionName);

  const updated: Project = {
    ...project,
    publishedVersion: versionName,
    updatedAt: nextUpdatedAt(project.updatedAt),
  };
  try {
    await projects.publish(updated, versionName, project.updatedAt);
  } catch (error) {
    if (isTransactionCancelled(error)) {
      throw new ConflictError(`Project "${projectName}" changed while publishing version "${versionName}"`);
    }
    throw error;
  }
  return updated;
}
