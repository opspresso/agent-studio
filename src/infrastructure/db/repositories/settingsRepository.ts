import { WORKSPACE_MODEL_RUNTIMES } from "@/domain/workspace/runtimeModels";
import type { SettingsRepository } from "@/domain/settings/repository";
import type {
  AppSettings,
  LlmProviderSetting,
} from "@/domain/settings/types";
import { getItem, updateItem } from "../store";
import { keys } from "../keys";

const ENTITY_TYPE = "SETTINGS" as const;

const FIELDS = [
  "defaultModel",
  "adminEmails",
  "allowedEmailDomains",
  "llmBaseUrl",
  "llmApiKey",
  "embeddingModel",
  "rerankerModel",
  "rerankerMinScore",
  "pluginsRepo",
  "pluginsRepoBranch",
  "githubToken",
  "a2aApiKey",
  "publicBaseUrl",
  "unknownModelPolicy",
] as const;

function fromItem(item: Record<string, unknown>): AppSettings {
  const settings: AppSettings = { updatedAt: item.updatedAt as string };
  for (const field of FIELDS) {
    const value = item[field];
    if (typeof value === "string") {
      settings[field] = value;
    }
  }
  if (
    item.artifactAccessMode === "authenticated" ||
    item.artifactAccessMode === "public" ||
    item.artifactAccessMode === "proxied"
  ) {
    settings.artifactAccessMode = item.artifactAccessMode;
  }
  if (Array.isArray(item.llmProviders)) {
    settings.llmProviders = item.llmProviders as LlmProviderSetting[];
  }
  if (Array.isArray(item.registeredModels)) {
    settings.registeredModels = item.registeredModels as NonNullable<AppSettings["registeredModels"]>;
  }
  if (item.workspaceModels && typeof item.workspaceModels === "object" && !Array.isArray(item.workspaceModels)) {
    settings.workspaceModels = {};
    for (const runtime of WORKSPACE_MODEL_RUNTIMES) {
      const model = (item.workspaceModels as Record<string, unknown>)[runtime];
      if (typeof model === "string" && model.length > 0 && model.length <= 200) settings.workspaceModels[runtime] = model;
    }
  }
  return settings;
}

export const settingsRepository: SettingsRepository = {
  async get() {
    const item = await getItem(keys.settings());
    return item ? fromItem(item) : null;
  },

  async update(mutate) {
    const result = await updateItem(keys.settings(), (existing) => ({
      entityType: ENTITY_TYPE,
      ...mutate(existing ? fromItem(existing) : null),
    }));
    return {
      before: result.before ? fromItem(result.before) : null,
      after: fromItem(result.after),
    };
  },
};
