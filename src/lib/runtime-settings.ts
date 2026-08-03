/**
 * Effective runtime configuration, resolved in one place:
 *
 *   workspace override  →  app override  →  environment  →  built-in default
 *
 * The first two are DB rows (the admin `/settings` page writes the app one, a
 * workspace admin writes its own); secrets are decrypted here, at the point of
 * use only.
 *
 * A workspace may only decide the keys in `TENANT_OVERRIDABLE_KEYS`, and the
 * resolution reads *through* that list rather than trusting the row — so a key
 * that was never meant to be a workspace's cannot become one by being written,
 * and narrowing the list takes effect on the next read rather than needing a
 * migration.
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

import type { AppSettings } from "@/domain/settings/types";
import { pickTenantOverrides } from "@/domain/settings/types";
import { currentTenant, DEFAULT_TENANT } from "@/shared/tenantContext";
import { settingsRepository } from "@/infrastructure/db/repositories/settingsRepository";
import { parseProviderConfigs } from "@/infrastructure/llm/providers";
import type { ProviderChannelConfig } from "@/infrastructure/llm/providers";
import { config, positiveIntEnv } from "./config";
import { createTtlCache } from "@/shared/ttlCache";
import { parseList } from "@/shared/parseList";
import { normalizeEmail } from "@/shared/email";
import { decryptSecret } from "@/infrastructure/crypto/secretEncryption";
import { log } from "@/shared/logger";

const DEFAULT_TTL_MS = 5_000;

// A non-positive TTL would either disable caching entirely or (negative) make
// every read a cache hit forever, so the floor is 1ms.
const TTL_MS = positiveIntEnv("SETTINGS_CACHE_TTL_MS", DEFAULT_TTL_MS, 1);

let cache: { value: AppSettings | null; fetchedAt: number } | undefined;
/**
 * Per workspace, under the same TTL and the same process-local invalidation —
 * and, unlike the app row above, under an entry cap as well.
 *
 * The app row has exactly one key. This map's key comes off a request: the A2A
 * route enters `withTenant(machineTenant(request))` and reads the inbound key
 * *before* checking it, so an unauthenticated caller varying `X-Tenant` chooses
 * the keys. A TTL alone never removes an entry nobody looks up again, so the
 * cap is what bounds the map rather than the caller's imagination.
 */
const tenantCache = createTtlCache<AppSettings | null>({ ttlMs: TTL_MS, maxEntries: 512 });

async function loadAppSettings(): Promise<AppSettings | null> {
  const now = Date.now();
  if (!cache || now - cache.fetchedAt > TTL_MS) {
    cache = { value: await settingsRepository.get(), fetchedAt: now };
  }
  return cache.value;
}

async function loadTenantSettings(tenant: string): Promise<AppSettings | null> {
  const cached = tenantCache.get(tenant);
  if (cached !== undefined) {
    return cached;
  }
  const value = await settingsRepository.getTenant(tenant);
  tenantCache.set(tenant, value);
  return value;
}

/**
 * The two override layers, flattened: a workspace's decisions over the
 * deployment's, and only for the keys a workspace may decide.
 *
 * Every getter below reads this rather than either row, which is what keeps
 * the order in one place — a getter that reached for the app row directly
 * would be a key a workspace silently cannot decide.
 */
async function loadSettings(): Promise<AppSettings | null> {
  const app = await loadAppSettings();
  const tenant = currentTenant();
  if (tenant === DEFAULT_TENANT) {
    return app;
  }
  const workspace = await loadTenantSettings(tenant);
  if (!workspace) {
    return app;
  }
  return { ...(app ?? { updatedAt: workspace.updatedAt }), ...pickTenantOverrides(workspace) };
}

export function invalidateSettingsCache(): void {
  cache = undefined;
  tenantCache.clear();
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
  return admins.length > 0 && admins.includes(normalizeEmail(email));
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
      apiKey: decryptSecret(provider.apiKey),
      keepModelPrefix: provider.keepModelPrefix ?? false,
    }));
  }
  return parseProviderConfigs(process.env);
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

export async function getToolsRepoConfig(): Promise<{
  repo: string | undefined;
  branch: string;
  token: string | undefined;
}> {
  const stored = await loadSettings();
  return {
    repo: stored?.toolsRepo ?? config.toolsRepo,
    branch: stored?.toolsRepoBranch ?? config.toolsRepoBranch,
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

/**
 * Whether this deployment dispatches a model missing from the registry.
 *
 * Anything but the exact string `refuse` reads as `allow`, including a typo:
 * the strict reading would be to refuse on anything unrecognised, but that
 * turns a misspelled setting into a platform-wide outage, and the value this
 * guard protects is a billing figure.
 */
export async function getUnknownModelPolicy(): Promise<"allow" | "refuse"> {
  const stored = (await loadSettings())?.unknownModelPolicy ?? config.unknownModelPolicy;
  return stored?.trim().toLowerCase() === "refuse" ? "refuse" : "allow";
}
