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
import { assertProjectWritable, userMayAccessProject } from "./projectUseCases";
import { modelFitsProjectType } from "./modelCompatibility";
import { nextUpdatedAt } from "./timestamps";
import { log } from "@/shared/logger";
import { hasMcpHeaderSecrets, mcpHeaderTarget } from "@/application/mcpHeaderTarget";

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

/**
 * Reject a list that names the same reference twice. Subagents because the
 * transfer tools address agents by name, so a duplicate is unaddressable; MCP
 * bindings because a duplicate opens the server's session twice and the second
 * row silently overwrites the first everywhere the run keys by server name (the
 * prompt's server table, the binding's tool selection); skills because a
 * duplicate is a duplicate row in the prompt's table. The console's pickers
 * cannot produce any of these — the API can, so the same write boundary that
 * checks references catches them.
 */
function assertUniqueReferences(refs: VersionRefs): void {
  const firstDuplicate = (names: readonly string[]): string | undefined => {
    const seen = new Set<string>();
    for (const name of names) {
      if (seen.has(name)) {
        return name;
      }
      seen.add(name);
    }
    return undefined;
  };
  const agent = firstDuplicate((refs.subagentList ?? []).map((ref) => ref.name));
  if (agent) {
    throw new ValidationError(
      `Agent name "${agent}" is used more than once; connected agents must have unique names.`,
    );
  }
  const mcp = firstDuplicate((refs.mcpList ?? []).map((binding) => binding.name));
  if (mcp) {
    throw new ValidationError(
      `MCP server "${mcp}" is bound more than once; a server can be bound once per version.`,
    );
  }
  const skill = firstDuplicate(refs.skillList ?? []);
  if (skill) {
    throw new ValidationError(
      `Skill "${skill}" is bound more than once; a skill can be bound once per version.`,
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

/**
 * Reject binding a local subagent project the editor may not access. A local
 * subagent runs another project inside this one's runs, so binding one is the
 * strongest form of reading it — a private project would otherwise be
 * reachable through any public project that named it. Only *added* refs are
 * checked, like the existence check above: a version stays editable after a
 * project it already bound went private, and the run-time transfer is the
 * platform's own composition, like the owner's token. A ref that does not
 * resolve is `assertReferencesExist`'s to report, not this one's.
 */
async function assertSubagentProjectsAccessible(
  refs: VersionRefRepos,
  next: VersionRefs,
  userEmail: string,
  existing?: VersionRefs,
): Promise<void> {
  const known = alreadyReferenced(existing).subagents;
  for (const ref of next.subagentList ?? []) {
    if (ref.type !== "local" || known.has(subagentKey(ref))) {
      continue;
    }
    const project = await refs.projects.get(ref.name);
    if (project && !(await userMayAccessProject(project, userEmail))) {
      throw new ValidationError(
        `Project "${ref.name}" is private; ask its owner for an invite before binding it as an agent.`,
      );
    }
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
 * stored under the same server, header name, and endpoint fingerprint. A move
 * drops preserved values; only credentials freshly entered for the current URL
 * survive. A binding with no overrides is stored without either secret field.
 */
async function resolveMcpBindings(
  cipher: SecretCipher,
  mcps: Pick<McpRepository, "get">,
  next: McpBinding[],
  existing: McpBinding[] = [],
): Promise<McpBinding[]> {
  const storedByName = new Map(existing.map((binding) => [binding.name, binding]));
  return Promise.all(
    next.map(async (binding) => {
      // Carry the binding forward and replace only the internal credential
      // fields. Rebuilding it from `{ name, headers }` is what silently dropped
      // `tools`; the submitted target is ignored because only the server can
      // bind a newly entered secret to the current registry URL.
      const { headers: submitted, headerTarget: _untrustedTarget, ...rest } = binding;
      if (!submitted || Object.keys(submitted).length === 0) {
        return rest;
      }
      const stored = storedByName.get(binding.name);
      const current = await mcps.get(binding.name);
      const hasNewSecret = Object.values(submitted).some(
        (value) => typeof value === "string" && value !== "" && !cipher.isMasked(value),
      );
      if (!current && hasNewSecret) {
        throw new ValidationError(
          `MCP server "${binding.name}" does not exist; its header credentials cannot be bound to an endpoint.`,
        );
      }
      const currentTarget = current ? mcpHeaderTarget(current.url) : undefined;
      const storedHeaders =
        !current || stored?.headerTarget === currentTarget ? stored?.headers ?? {} : {};
      const headers = cipher.mergeHeaderOverrideUpdate(storedHeaders, submitted);
      if (Object.keys(headers).length === 0) {
        return rest;
      }
      const headerTarget = hasMcpHeaderSecrets(headers)
        ? currentTarget ?? stored?.headerTarget
        : undefined;
      return { ...rest, headers, ...(headerTarget ? { headerTarget } : {}) };
    }),
  );
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
  if (!bindings.some((binding) => binding.headers)) {
    return bindings;
  }
  const saved = versionName ? await versions.get(projectName, versionName) : null;
  return resolveMcpBindings(cipher, mcps, bindings, saved?.mcpList ?? []);
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
        ? { ...binding, headers: cipher.maskHeaderOverrides(binding.headers) }
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
function assertProjectModelType(project: Project, model: string): void {
  const cfg = getModelConfig(model);
  if (!cfg) {
    return;
  }
  if (!modelFitsProjectType(project.projectType, cfg)) {
    throw new ValidationError(
      `Model type does not support ${project.projectType} projects: ${model}`,
    );
  }
}

function assertModelSupports(project: Project, model: string, parameters: VersionParameters): void {
  const cfg = getModelConfig(model);
  if (!cfg) {
    return;
  }
  assertProjectModelType(project, model);
  if (project.projectType === "agent" && !cfg.capabilities.tools) {
    throw new ValidationError(
      `Model does not support tool calling required by agent projects: ${model}`,
    );
  }
  if (parameters.structuredOutput && !cfg.capabilities.structuredOutput) {
    throw new ValidationError(`Model does not support structured output: ${model}`);
  }
  if (parameters.reasoningTrace && !cfg.capabilities.reasoning) {
    throw new ValidationError(`Model does not produce reasoning to record: ${model}`);
  }
}

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
  assertToolBindingsRunnable(project, input);
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
    mcpList: await resolveMcpBindings(cipher, refs.mcps, input.mcpList),
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
      ? await resolveMcpBindings(cipher, refs.mcps, input.mcpList, existing.mcpList)
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
): Promise<void> {
  const project = await assertProjectWritable(projects, projectName, userEmail);
  // Resolve through the repository so the "published" sentinel names the real
  // version — the guard below and the delete key must both see that name.
  const existing = await getVersion(versions, projectName, versionName);
  if (project.publishedVersion === existing.versionName) {
    throw new ConflictError(`Published version "${existing.versionName}" cannot be deleted`);
  }
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
      deleteVersion(deps.versions, deps.projects, projectName, versionName, userEmail),

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
