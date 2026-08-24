/**
 * Effective runtime configuration: DB-stored overrides (managed on the
 * /settings page) take precedence over environment variables. Secrets are
 * decrypted here, at the point of use only.
 *
 * The DB read is cached in memory and invalidated on write, but the invalidation
 * is process-local. On a horizontally-scaled deployment a change made on one
 * instance (rotating the A2A key, demoting an admin, tightening the allowed
 * sign-in domains) is observed by other instances only once their own cache
 * entry expires, so the TTL is the bound on how long a revoked credential keeps
 * working somewhere in the fleet. It is short by default for that reason: the
 * cached item is a single small row, so the reads it saves are worth far less
 * than the staleness they buy. Immediate cross-instance revocation would need a
 * shared invalidation signal, which is deliberately out of scope.
 */

import type { AppSettings, ArtifactAccessMode } from "@/domain/settings/types";
import {
  toUnknownModelPolicy,
  type UnknownModelPolicy,
} from "@/domain/settings/modelPolicy";
import { settingsRepository } from "@/infrastructure/db/repositories/settingsRepository";
import { parseProviderConfigs } from "@/infrastructure/llm/providers";
import type { ProviderChannelConfig } from "@/infrastructure/llm/providers";
import { config, positiveIntEnv } from "./config";
import { parseList } from "@/shared/parseList";
import { decryptSecret } from "@/infrastructure/crypto/secretEncryption";

const DEFAULT_TTL_MS = 5_000;

// A non-positive TTL would either disable caching entirely or (negative) make
// every read a cache hit forever, so the floor is 1ms.
const TTL_MS = positiveIntEnv("SETTINGS_CACHE_TTL_MS", DEFAULT_TTL_MS, 1);

let cache: { value: AppSettings | null; fetchedAt: number } | undefined;
let cacheGeneration = 0;

async function loadSettings(): Promise<AppSettings | null> {
  const now = Date.now();
  if (!cache || now - cache.fetchedAt > TTL_MS) {
    const generation = cacheGeneration;
    const value = await settingsRepository.get();
    if (generation === cacheGeneration) {
      cache = { value, fetchedAt: now };
    }
    return value;
  }
  return cache.value;
}

export function invalidateSettingsCache(): void {
  cacheGeneration += 1;
  cache = undefined;
}

export async function getAdminEmails(): Promise<string[]> {
  const stored = (await loadSettings())?.adminEmails;
  return stored !== undefined ? parseList(stored) : config.adminEmails;
}

/**
 * Whether an address is on an *explicitly configured* admin list.
 *
 * Deliberately not {@link isAdminEmail}, and the difference is the whole point:
 * an empty list is a safe "no restriction" for a shared registry, but it must
 * never read as "everyone is an admin" where admin is an override on someone
 * else's ownership — on a deployment that never set `ADMIN_EMAILS` that would
 * silently hand every signed-in user write access to every project. With no
 * list configured there are no admins, and ownership stands on its own.
 */
export async function isConfiguredAdmin(email: string): Promise<boolean> {
  const admins = await getAdminEmails();
  return admins.length > 0 && admins.includes(email.toLowerCase());
}

/**
 * Whether an address may perform admin-gated actions — registry mutations and
 * app settings. An empty list means "no restriction", which is what an unset
 * `ADMIN_EMAILS` has always meant here.
 *
 * Written on top of {@link isConfiguredAdmin} so the membership test itself has
 * one spelling: the two questions differ *only* in what an empty list means, and
 * that is what the expression should show.
 */
export async function isAdminEmail(email: string): Promise<boolean> {
  return (await getAdminEmails()).length === 0 || (await isConfiguredAdmin(email));
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
      // A `sigv4` row stores an empty key, which is not ciphertext — decrypting
      // it would be asking the cipher to answer a question it was never given.
      apiKey: provider.apiKey === "" ? "" : decryptSecret(provider.apiKey),
      keepModelPrefix: provider.keepModelPrefix ?? false,
      auth: provider.auth ?? "bearer",
    }));
  }
  return parseProviderConfigs(process.env);
}

export async function getPluginsRepoConfig(): Promise<{
  repo: string | undefined;
  branch: string;
  token: string | undefined;
}> {
  const stored = await loadSettings();
  return {
    repo: stored?.pluginsRepo ?? config.pluginsRepo,
    branch: stored?.pluginsRepoBranch ?? config.pluginsRepoBranch,
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

export async function getArtifactAccessMode(): Promise<ArtifactAccessMode> {
  const value = (await loadSettings())?.artifactAccessMode ?? process.env.ARTIFACT_ACCESS_MODE;
  return value === "public" || value === "proxied" ? value : "authenticated";
}

/**
 * The enabled-model allowlist; `undefined` means no restriction. Read at
 * selection time only (the /api/models list) — the run bracket never sees it,
 * so a version already holding a disabled model keeps running.
 */
export async function getEnabledModels(): Promise<string[] | undefined> {
  return (await loadSettings())?.enabledModels;
}

/**
 * The deployment's self-hosted model declarations, as stored; `[]` when none.
 * DB-only — there is no env fallback, because the deployment is the publisher
 * of these and a declaration is data, not configuration. Read by the catalog
 * refresher (boot and every tick) and installed into the registry overlay.
 */
export async function getSelfHostedModels(): Promise<unknown[]> {
  return (await loadSettings())?.selfHostedModels ?? [];
}

/**
 * Whether a run may execute a model the registry cannot price. Injected into
 * the run bracket rather than read there — `application` may not import this
 * module. The parsing is the domain's, one layer below both of us.
 */
export async function getUnknownModelPolicy(): Promise<UnknownModelPolicy> {
  const stored = (await loadSettings())?.unknownModelPolicy;
  return toUnknownModelPolicy(stored ?? process.env.UNKNOWN_MODEL_POLICY);
}
