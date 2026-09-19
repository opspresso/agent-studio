import { assertUniqueReferences, assertReferencesExist, assertSubagentProjectsAccessible,
  assertValidImageModel, warnUnknownCatalogModel, assertProjectModelType, assertModelSupports,
  type AgentConfigurationInput, type ConfigurationRefRepos } from "./configurationPolicy";
import { resolveMcpBindings } from "./mcpBindingSettings";
export type VersionRefRepos = ConfigurationRefRepos;
import type { ProjectRepository, VersionRepository } from "@/domain/project/repository";
import type {
  McpBinding,
  Project,
  Version,
} from "@/domain/project/types";
import type { SecretCipher } from "@/domain/security/secretCipher";
import { versionMcpHeadersContext } from "@/domain/security/secretContext";
import type { McpRepository } from "@/domain/mcp/repository";
import { ConflictError, NotFoundError, isConditionalWriteFailure, isTransactionCancelled } from "@/application/errors";
import { assertProjectWritable } from "./projectUseCases";
import { nextUpdatedAt } from "@/shared/nextUpdatedAt";

export interface VersionInput extends AgentConfigurationInput {
  userPromptTemplate: string;
}

/**
 * Resolve a draft's masked header overrides against the stored version, for
 * previewing an unsaved draft. The console reads overrides masked, so a draft
 * round-tripped through the editor carries `ab••••••yz` where a secret was.
 * The save path above already resolves those against what is stored, and a
 * preview claims to show what a run would send, so it has to resolve the same
 * way or it is describing a different request. This is deliberately the only
 * sibling of that path: a third reading of what a mask means lived in a route
 * handler once, and the two had no reason to stay identical.
 *
 * A freshly typed value is bound to the registry's current URL. A mask whose
 * saved target no longer matches is dropped rather than allowing an old
 * endpoint's credential to follow a registry name to a new endpoint.
 */
export async function resolveDraftMcpBindings(
  versions: Pick<VersionRepository, "get">,
  mcps: Pick<McpRepository, "get">,
  cipher: SecretCipher,
  projectName: string,
  versionName: string | undefined,
  bindings: McpBinding[],
): Promise<McpBinding[]> {
  if (!versionName && !bindings.some((binding) => binding.headers)) {
    return bindings;
  }
  const saved = versionName ? await versions.get(projectName, versionName) : null;
  return resolveMcpBindings(
    cipher,
    mcps,
    bindings,
    saved?.mcpList ?? [],
    (server) => versionMcpHeadersContext(projectName, "draft", server),
    (server) => versionMcpHeadersContext(projectName, saved?.versionName ?? "draft", server),
  );
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
    // Masked in place, for the same reason as the write path above: naming the
    // fields to keep is how the ones nobody thought of get lost.
    mcpList: version.mcpList.map(({ headerTarget: _internal, ...binding }) =>
      binding.headers
        ? {
            ...binding,
            headers: cipher.maskHeaderOverrides(
              binding.headers,
              versionMcpHeadersContext(
                version.projectName,
                version.versionName,
                binding.name,
              ),
            ),
          }
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

function nextVersionName(existing: Version[]): string {
  const maxNumeric = existing.reduce((max, version) => {
    const parsed = Number(version.versionName);
    return Number.isInteger(parsed) && parsed > max ? parsed : max;
  }, 0);
  return String(maxNumeric + 1);
}

export const VERSION_LIST_PAGE_SIZE = 100;

export async function listVersions(
  repo: Pick<VersionRepository, "list">,
  projectName: string,
): Promise<Version[]> {
  const versions: Version[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await repo.list(projectName, VERSION_LIST_PAGE_SIZE, after);
    versions.push(...page);
    if (page.length < VERSION_LIST_PAGE_SIZE) {
      return versions;
    }
    after = page.at(-1)!.versionName;
  }
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
  if (input.fallbackModel) {
    assertProjectModelType(project, input.fallbackModel);
  }
  warnUnknownCatalogModel(projectName, input.model);
  assertUniqueReferences(input);
  await assertReferencesExist(refs, input);
  await assertSubagentProjectsAccessible(refs, input, userEmail);
  const existing = await listVersions(versions, projectName);

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
    mcpList: await resolveMcpBindings(
      cipher,
      refs.mcps,
      input.mcpList,
      [],
      (server) => versionMcpHeadersContext(projectName, versionName, server),
    ),
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
  // Only the lists this update supplies; an omitted list keeps the stored one,
  // which its own write already checked.
  assertUniqueReferences(input);
  await assertReferencesExist(refs, input, existing);
  await assertSubagentProjectsAccessible(refs, input, userEmail, existing);
  const updated: Version = {
    ...existing,
    systemPrompt: input.systemPrompt ?? existing.systemPrompt,
    userPromptTemplate: input.userPromptTemplate ?? existing.userPromptTemplate,
    model: input.model ?? existing.model,
    fallbackModel:
      input.fallbackModel === null ? undefined : input.fallbackModel ?? existing.fallbackModel,
    parameters: input.parameters ?? existing.parameters,
    mcpList: input.mcpList
      ? await resolveMcpBindings(
          cipher,
          refs.mcps,
          input.mcpList,
          existing.mcpList,
          (server) => versionMcpHeadersContext(projectName, existing.versionName, server),
        )
      : existing.mcpList,
    skillList: input.skillList ?? existing.skillList,
    subagentList: input.subagentList ?? existing.subagentList,
    maxTurn: input.maxTurn === null ? undefined : input.maxTurn ?? existing.maxTurn,
  };
  assertModelSupports(project, updated.model, updated.parameters);
  if (updated.fallbackModel) {
    assertProjectModelType(project, updated.fallbackModel);
  }
  await versions.put(updated);
  return updated;
}

export async function deleteVersion(
  versions: VersionRepository,
  projects: ProjectRepository,
  projectName: string,
  versionName: string,
  userEmail: string,
  assertUnused?: (project: Project, version: Version) => Promise<void>,
): Promise<void> {
  const project = await assertProjectWritable(projects, projectName, userEmail);
  // Resolve through the repository so the "published" sentinel names the real
  // version — the guard below and the delete key must both see that name.
  const existing = await getVersion(versions, projectName, versionName);
  if (project.publishedVersion === existing.versionName) {
    throw new ConflictError(`Published version "${existing.versionName}" cannot be deleted`);
  }
  await assertUnused?.(project, existing);
  try {
    await versions.delete(projectName, existing.versionName, project.updatedAt);
  } catch (error) {
    if (isTransactionCancelled(error)) {
      throw new ConflictError(
        `Version "${existing.versionName}" changed while it was being deleted`,
      );
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
  const version = await getVersion(versions, projectName, versionName);

  const updated: Project = {
    ...project,
    publishedVersion: version.versionName,
    updatedAt: nextUpdatedAt(project.updatedAt),
  };
  try {
    await projects.publish(updated, version.versionName, project.updatedAt);
  } catch (error) {
    if (isTransactionCancelled(error)) {
      throw new ConflictError(`Project "${projectName}" changed while publishing version "${versionName}"`);
    }
    throw error;
  }
  return updated;
}

/**
 * The slice bound to its repositories, composed once by the composition root.
 * See {@link createProjectUseCases} for why both forms exist and which one a
 * caller should reach for.
 *
 * Every entry here bound five to eight positional arguments at the route
 * boundary, four of which — both repositories, the reference lookups and the
 * cipher — were the same values on every call. A route was choosing them, which
 * meant a route could choose them wrongly: `refs` is what stops a version from
 * storing a dangling skill or subagent reference, and nothing but convention
 * had every caller passing it.
 */
export interface VersionUseCasesDeps {
  versions: VersionRepository;
  projects: ProjectRepository;
  /** Registry lookups a version's references are validated against. */
  refs: VersionRefRepos;
  cipher: SecretCipher;
  assertUnused?: (project: Project, version: Version) => Promise<void>;
}

/**
 * Declared rather than inferred, like the other three slices. `toView` is the
 * member with the least margin for a silently changed shape — it exists to mask
 * the secrets a response must not carry — and an inferred surface moves that
 * check from the factory to each of the eight call sites.
 */
export interface VersionUseCases {
  list(projectName: string): Promise<Version[]>;
  get(projectName: string, versionName: string): Promise<Version>;
  create(projectName: string, input: CreateVersionInput, userEmail: string): Promise<Version>;
  update(
    projectName: string,
    versionName: string,
    input: UpdateVersionInput,
    userEmail: string,
  ): Promise<Version>;
  remove(projectName: string, versionName: string, userEmail: string): Promise<void>;
  publish(projectName: string, versionName: string, userEmail: string): Promise<Project>;
  /** See {@link resolveDraftMcpBindings} — a preview's masked headers, resolved. */
  resolveDraftMcpBindings(
    projectName: string,
    versionName: string | undefined,
    bindings: McpBinding[],
  ): Promise<McpBinding[]>;
  /** See {@link toVersionView} — masks the secrets a response must not carry. */
  toView(version: Version): Version;
}

export function createVersionUseCases(deps: VersionUseCasesDeps): VersionUseCases {
  return {
    list: (projectName: string): Promise<Version[]> => listVersions(deps.versions, projectName),

    get: (projectName: string, versionName: string): Promise<Version> =>
      getVersion(deps.versions, projectName, versionName),

    create: (projectName: string, input: CreateVersionInput, userEmail: string): Promise<Version> =>
      createVersion(deps.versions, deps.projects, projectName, input, userEmail, deps.refs, deps.cipher),

    update: (
      projectName: string,
      versionName: string,
      input: UpdateVersionInput,
      userEmail: string,
    ): Promise<Version> =>
      updateVersion(
        deps.versions,
        deps.projects,
        projectName,
        versionName,
        input,
        userEmail,
        deps.refs,
        deps.cipher,
      ),

    remove: (projectName: string, versionName: string, userEmail: string): Promise<void> =>
      deleteVersion(deps.versions, deps.projects, projectName, versionName, userEmail, deps.assertUnused),

    publish: (projectName: string, versionName: string, userEmail: string): Promise<Project> =>
      publishVersion(deps.projects, deps.versions, projectName, versionName, userEmail),

    /** See {@link resolveDraftMcpBindings} — a preview's masked headers, resolved. */
    resolveDraftMcpBindings: (
      projectName: string,
      versionName: string | undefined,
      bindings: McpBinding[],
    ): Promise<McpBinding[]> =>
      resolveDraftMcpBindings(
        deps.versions,
        deps.refs.mcps,
        deps.cipher,
        projectName,
        versionName,
        bindings,
      ),

    /** See {@link toVersionView} — masks the secrets a response must not carry. */
    toView: (version: Version): Version => toVersionView(deps.cipher, version),
  };
}
