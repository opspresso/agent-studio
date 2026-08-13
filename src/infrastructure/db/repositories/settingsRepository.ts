import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { SettingsRepository } from "@/domain/settings/repository";
import type { AppSettings, LlmProviderSetting } from "@/domain/settings/types";
import { getDocumentClient, getTableName } from "../client";
import { keys } from "../keys";

const ENTITY_TYPE = "SETTINGS" as const;

const FIELDS = [
  "adminEmails",
  "allowedEmailDomains",
  "llmBaseUrl",
  "llmApiKey",
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
  if (Array.isArray(item.llmProviders)) {
    settings.llmProviders = item.llmProviders as LlmProviderSetting[];
  }
  if (Array.isArray(item.enabledModels)) {
    settings.enabledModels = item.enabledModels as string[];
  }
  return settings;
}

export const settingsRepository: SettingsRepository = {
  async get() {
    const res = await getDocumentClient().send(
      new GetCommand({ TableName: getTableName(), Key: keys.settings() }),
    );
    return res.Item ? fromItem(res.Item) : null;
  },

  async put(settings) {
    await getDocumentClient().send(
      new PutCommand({
        TableName: getTableName(),
        Item: { ...keys.settings(), entityType: ENTITY_TYPE, ...settings },
      }),
    );
  },
};
