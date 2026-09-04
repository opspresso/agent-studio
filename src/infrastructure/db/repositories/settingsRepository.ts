import type { SettingsRepository } from "@/domain/settings/repository";
import type {
  AppSettings,
  LlmProviderSetting,
  SelfHostedModelSetting,
} from "@/domain/settings/types";
import { getItem, updateItem } from "../store";
import { keys } from "../keys";

const ENTITY_TYPE = "SETTINGS" as const;

const FIELDS = [
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
  if (Array.isArray(item.hiddenModels)) {
    settings.hiddenModels = item.hiddenModels as string[];
  }
  if (Array.isArray(item.selfHostedModels)) {
    settings.selfHostedModels = item.selfHostedModels as SelfHostedModelSetting[];
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
