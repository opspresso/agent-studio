/**
 * Effective runtime configuration: DB-stored overrides (managed on the
 * /settings page) take precedence over environment variables. Secrets are
 * decrypted here, at the point of use only.
 *
 * The DB read is cached in memory (TTL below) and invalidated on write —
 * single-instance assumption, same as the in-memory A2A task store.
 */

import type { AppSettings } from "@/domain/settings/types";
import { settingsRepository } from "@/infrastructure/db/repositories/settingsRepository";
import { parseProviderConfigs } from "@/infrastructure/llm/providers";
import type { ProviderChannelConfig } from "@/infrastructure/llm/providers";
import { config } from "./config";
import { decryptSecret } from "./secret-encryption";

const TTL_MS = 30_000;

let cache: { value: AppSettings | null; fetchedAt: number } | undefined;

async function loadSettings(): Promise<AppSettings | null> {
  const now = Date.now();
  if (!cache || now - cache.fetchedAt > TTL_MS) {
    cache = { value: await settingsRepository.get(), fetchedAt: now };
  }
  return cache.value;
}

export function invalidateSettingsCache(): void {
  cache = undefined;
}

function parseList(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export async function getAdminEmails(): Promise<string[]> {
  const stored = (await loadSettings())?.adminEmails;
  return stored !== undefined ? parseList(stored) : config.adminEmails;
}

export async function getAllowedEmailDomains(): Promise<string[]> {
  const stored = (await loadSettings())?.allowedEmailDomains;
  return stored !== undefined ? parseList(stored) : config.allowedEmailDomains;
}

export async function getLlmChannelConfig(): Promise<{ baseUrl: string; apiKey: string }> {
  const stored = await loadSettings();
  return {
    baseUrl: stored?.llmBaseUrl ?? config.llmBaseUrl,
    apiKey: stored?.llmApiKey !== undefined ? decryptSecret(stored.llmApiKey) : config.llmApiKey,
  };
}

export async function getLlmProviderConfigs(): Promise<ProviderChannelConfig[]> {
  const stored = (await loadSettings())?.llmProviders;
  if (stored !== undefined) {
    return stored.map((provider) => ({
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: decryptSecret(provider.apiKey),
      keepModelPrefix: provider.keepModelPrefix ?? false,
    }));
  }
  return parseProviderConfigs(process.env);
}

export async function getSlackDefaultProject(): Promise<string | undefined> {
  return (await loadSettings())?.slackDefaultProject ?? config.slackDefaultProject;
}

export async function getSlackBotToken(): Promise<string | undefined> {
  const stored = (await loadSettings())?.slackBotToken;
  return stored !== undefined ? decryptSecret(stored) : config.slackBotToken;
}

export async function getSlackSigningSecret(): Promise<string | undefined> {
  const stored = (await loadSettings())?.slackSigningSecret;
  return stored !== undefined ? decryptSecret(stored) : config.slackSigningSecret;
}

export async function getSkillsRepoConfig(): Promise<{
  repo: string | undefined;
  branch: string;
  token: string | undefined;
}> {
  const stored = await loadSettings();
  return {
    repo: stored?.skillsRepo ?? config.skillsRepo,
    branch: stored?.skillsRepoBranch ?? config.skillsRepoBranch,
    token: stored?.githubToken !== undefined ? decryptSecret(stored.githubToken) : config.githubToken,
  };
}

export async function getA2aApiKey(): Promise<string | undefined> {
  const stored = (await loadSettings())?.a2aApiKey;
  return stored !== undefined ? decryptSecret(stored) : config.a2aApiKey;
}

export async function getPublicBaseUrl(): Promise<string | undefined> {
  return (await loadSettings())?.publicBaseUrl ?? config.publicBaseUrl;
}
