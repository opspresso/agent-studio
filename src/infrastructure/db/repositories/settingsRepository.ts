import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { SettingsRepository } from "@/domain/settings/repository";
import type { AppSettings, LlmProviderSetting } from "@/domain/settings/types";
import { getDocumentClient, getTableName } from "../client";
import { keys } from "../keys";

const ENTITY_TYPE = "SETTINGS" as const;
const TENANT_ENTITY_TYPE = "TENANTSETTINGS" as const;

const FIELDS = [
  "adminEmails",
  "allowedEmailDomains",
  "llmBaseUrl",
  "llmApiKey",
  "skillsRepo",
  "skillsRepoBranch",
  "toolsRepo",
  "toolsRepoBranch",
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

  /**
   * One workspace's overrides. Read through `pickTenantOverrides` at the point
   * of use rather than filtered here: what a workspace may decide is a policy,
   * and a stored row that predates a narrowing of that list must lose the key
   * rather than keep it.
   */
  async getTenant(tenant) {
    const res = await getDocumentClient().send(
      new GetCommand({ TableName: getTableName(), Key: keys.tenantSettings(tenant) }),
    );
    return res.Item ? fromItem(res.Item) : null;
  },

  async putTenant(tenant, settings) {
    await getDocumentClient().send(
      new PutCommand({
        TableName: getTableName(),
        Item: {
          ...keys.tenantSettings(tenant),
          entityType: TENANT_ENTITY_TYPE,
          ...settings,
        },
      }),
    );
  },
};
