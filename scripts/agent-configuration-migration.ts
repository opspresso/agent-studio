import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { AgentConfiguration, Project } from "@/domain/project/types";
import type { AudioJobStatus } from "@/domain/audio/job";
import { isAudioJobTerminal } from "@/domain/audio/job";
import type { SecretCipher } from "@/domain/security/secretCipher";
import { agentMcpHeadersContext, versionMcpHeadersContext } from "@/domain/security/secretContext";
import { assertModelSupports, assertProjectModelType, assertUniqueReferences, assertValidImageModel } from "@/application/project/configurationPolicy";
import { agentConfigurationInputSchema } from "@/app/api/projects/_lib/schemas";
import { keys } from "@/infrastructure/db/keys";
import { getItem, queryItems, transact, type Item, type QueryInput } from "@/infrastructure/db/store";
import { projectIsLive } from "@/infrastructure/db/projectLifecycle";
import { toMcpBindings } from "@/infrastructure/db/projectConfiguration";
import { nextUpdatedAt } from "@/shared/nextUpdatedAt";

export interface AgentMigrationOverrides {
  model?: string;
  imageModel?: string;
  fallbackModel?: string | null;
  systemPrompt?: string;
  discardUserPromptTemplate?: boolean;
}

export class AgentMigrationError extends Error {}

export interface AgentMigrationPlan {
  projectName: string;
  status: "ready" | "current" | "blocked";
  sourceType?: string;
  sourceVersion?: string;
  model?: string;
  expectedFingerprint: string;
  audioRecipe: "unchanged" | "current-agent";
  issues: string[];
}

const PAGE_SIZE = 100;

async function* pages(query: QueryInput) {
  let after: string | undefined;
  do {
    const rows = await queryItems({ ...query, limit: PAGE_SIZE, ...(after ? { after } : {}) });
    for (const row of rows) yield row;
    if (rows.length < PAGE_SIZE) return;
    after = String(rows.at(-1)![query.index === "GSI1" ? "GSI1SK" : "SK"]);
  } while (true);
}

/** Raw catalog reads also include the retired project types the runtime refuses. */
export async function* migrationProjectNames() {
  for await (const row of pages({ index: "GSI1", pk: keys.typePartition("PROJECT") })) {
    if (projectIsLive(row) && typeof row.name === "string") yield row.name;
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function inspect(projectName: string, overrides: AgentMigrationOverrides) {
  const project = await getItem(keys.project(projectName));
  const archive = await getItem(keys.legacyProjectConfiguration(projectName));
  const audioConfig = await getItem(keys.audioJobConfig(projectName));
  const recipe = audioConfig?.config as { enabled?: boolean; revision: number; updatedAt: string;
    postprocess?: { projectName?: string; versionName?: string } } | undefined;
  const legacyRecipe = recipe?.postprocess?.versionName !== undefined;
  const fingerprint = createHash("sha256").update(JSON.stringify([project, audioConfig, overrides]));
  let selected: Item | undefined;
  let newest: Item | undefined;
  for await (const row of pages({ pk: keys.projectPartition(projectName), sk: { prefix: keys.versionPrefix() } })) {
    fingerprint.update(JSON.stringify(row));
    if (row.versionName === project?.publishedVersion) selected = row;
    if (!newest || String(row.createdAt ?? "") > String(newest.createdAt ?? "") ||
      row.createdAt === newest.createdAt && String(row.versionName) > String(newest.versionName)) newest = row;
  }
  const issues: string[] = [];
  if (!projectIsLive(project)) issues.push("Project is missing or being deleted");
  if (project && (project.name !== projectName || ["displayName", "ownerEmail", "updatedAt"].some(key =>
    typeof project[key] !== "string" || !project[key]))) issues.push("Project metadata is invalid");
  if (project && !["agent", "llm", "image"].includes(String(project.projectType))) issues.push("Unknown project type");
  if (project?.projectType !== "agent" && project?.configuration !== undefined) issues.push("Legacy project already carries current settings; inspect the conflicting sources");
  const hasCurrentSettings = project?.projectType === "agent" && project.configuration !== undefined;
  const current = !legacyRecipe && project?.projectType === "agent" && (hasCurrentSettings ||
    !newest && archive?.entityType === "LegacyProjectConfiguration");
  if (!current && archive) issues.push("A migration archive already exists; inspect the project before retrying");
  if (!current && project?.publishedVersion && !selected) issues.push("Published Version is missing; restore the source before migrating");
  if (!project?.publishedVersion) selected = newest;
  if (legacyRecipe && recipe?.enabled && recipe.postprocess?.versionName !== "published") {
    issues.push("Use the published Audio postprocessor or disable the recipe in the old app before migrating a fixed Version reference");
  }
  if (legacyRecipe && (!Number.isSafeInteger(recipe?.revision) || typeof recipe?.postprocess?.projectName !== "string")) {
    issues.push("Audio recipe metadata is invalid");
  }

  // A stopped worker can still leave queued work. Do not reinterpret its pinned inputs.
  for await (const row of pages({ pk: keys.projectPartition(projectName), sk: { prefix: keys.audioJobPrefix() } })) {
    const job = row.job as { status?: AudioJobStatus } | undefined;
    if (!current && (!job?.status || !isAudioJobTerminal(job.status))) {
      issues.push("Drain or cancel existing Audio jobs with the old application before migrating");
      break;
    }
  }

  let configuration: AgentConfiguration | undefined;
  if (!hasCurrentSettings && selected && project && issues.length === 0) {
    if (selected.projectName !== projectName || typeof selected.versionName !== "string") issues.push("Version identity is invalid");
    if (project.projectType === "image" && !overrides.model) issues.push("Image projects require an explicit Agent text model override");
    if (project.projectType === "llm" && selected.userPromptTemplate &&
      overrides.systemPrompt === undefined && !overrides.discardUserPromptTemplate) {
      issues.push("Replace the user prompt template with systemPrompt or explicitly discard it; the original stays archived");
    }
    if (issues.length === 0) {
      try {
        const image = project.projectType === "image";
        const parameters = selected.parameters && typeof selected.parameters === "object" ? selected.parameters : {};
        const input = agentConfigurationInputSchema.parse({
          ...selected,
          model: overrides.model ?? selected.model,
          fallbackModel: overrides.fallbackModel === null ? undefined : overrides.fallbackModel ?? (image ? undefined : selected.fallbackModel),
          systemPrompt: overrides.systemPrompt ?? selected.systemPrompt ?? "",
          parameters: { ...parameters, ...(image ? { imageGeneration: true, imageModel: overrides.imageModel ?? selected.model }
            : overrides.imageModel ? { imageModel: overrides.imageModel } : {}) },
          mcpList: selected.mcpList,
        });
        configuration = { projectName, ...input };
        // Storage-only endpoint fingerprints are not part of the public input schema.
        configuration.mcpList = toMcpBindings(selected.mcpList);
        const agent = { ...project, projectType: "agent" } as unknown as Project;
        assertModelSupports(agent, configuration.model, configuration.parameters);
        if (configuration.fallbackModel) assertProjectModelType(agent, configuration.fallbackModel);
        assertValidImageModel(configuration.parameters);
        assertUniqueReferences(configuration);
      } catch {
        issues.push("Source settings do not satisfy the current Agent schema or model capabilities; provide valid overrides");
      }
    }
  }
  const plan: AgentMigrationPlan = {
    projectName,
    status: issues.length ? "blocked" : current || !legacyRecipe && project?.projectType === "agent" && !selected ? "current" : "ready",
    ...(project ? { sourceType: String(project.projectType) } : {}),
    ...(selected ? { sourceVersion: String(selected.versionName) } : {}),
    ...(configuration ? { model: configuration.model } : {}),
    expectedFingerprint: fingerprint.digest("hex"), audioRecipe: legacyRecipe ? "current-agent" : "unchanged", issues,
  };
  return { plan, project, selected, configuration, audioConfig, recipe };
}

/** Safe to print: no prompts, personal data, settings, headers or ciphertext. */
export async function planAgentMigration(name: string, overrides: AgentMigrationOverrides = {}): Promise<AgentMigrationPlan> {
  return (await inspect(name, overrides)).plan;
}

/** Offline, one-project transaction. The old META and every VERSION row are preserved. */
export async function applyAgentMigration(
  name: string, expectedFingerprint: string, cipher: SecretCipher, overrides: AgentMigrationOverrides = {},
): Promise<AgentMigrationPlan> {
  const { plan, project, selected, configuration, audioConfig, recipe } = await inspect(name, overrides);
  if (plan.expectedFingerprint !== expectedFingerprint) throw new AgentMigrationError("Migration plan changed; inspect a fresh plan before applying");
  if (plan.status === "blocked") throw new AgentMigrationError(plan.issues.join("; "));
  if (plan.status === "current") return plan;
  if (!project) throw new AgentMigrationError("Project disappeared during migration");
  const migrated = configuration ? { ...configuration, mcpList: configuration.mcpList.map(binding => {
    if (!binding.headers) return binding;
    const oldContext = versionMcpHeadersContext(name, String(selected!.versionName), binding.name);
    return { ...binding, headers: cipher.mergeHeaderOverrideUpdate(binding.headers,
      cipher.maskHeaderOverrides(binding.headers, oldContext), agentMcpHeadersContext(name, binding.name), oldContext) };
  }) } : undefined;
  const { publishedVersion: _published, ...metadata } = project;
  await transact([
    ...(selected ? [{ kind: "check" as const, key: keys.version(name, String(selected.versionName)),
      condition: (row: Item | null) => isDeepStrictEqual(row, selected) }] : []),
    { kind: "put", item: { ...keys.legacyProjectConfiguration(name), entityType: "LegacyProjectConfiguration", project,
      sourceVersion: selected?.versionName, ...(audioConfig ? { audioConfig } : {}), sourceFingerprint: digest(project) }, condition: row => row === null },
    ...(audioConfig && plan.audioRecipe === "current-agent" ? [{ kind: "put" as const,
      item: { ...audioConfig, config: { ...recipe, revision: recipe!.revision + 1, updatedAt: nextUpdatedAt(recipe!.updatedAt),
        postprocess: { projectName: recipe!.postprocess!.projectName } } },
      condition: (row: Item | null) => isDeepStrictEqual(row, audioConfig) }] : []),
    { kind: "put", item: { ...metadata, projectType: "agent", ...(migrated ? { configuration: migrated } : {}),
      updatedAt: nextUpdatedAt(String(project.updatedAt)) }, condition: row => isDeepStrictEqual(row, project) },
  ]);
  return { ...plan, status: "current" };
}
