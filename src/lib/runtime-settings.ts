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

import type { WorkspaceRuntime } from "@/domain/workspace/types";
import { workspaceModelChannel, workspaceRuntimeModelCompatible } from "@/domain/workspace/runtimeModels";
import { withWorkspaceModelChannel } from "@/infrastructure/workspace/runtimeAdapters";
import type { AppSettings, ArtifactAccessMode } from "@/domain/settings/types";
import {
  toUnknownModelPolicy,
  type UnknownModelPolicy,
} from "@/domain/settings/modelPolicy";
import { settingsRepository } from "@/infrastructure/db/repositories/settingsRepository";
import { parseProviderConfigs, resolveProviderTarget, type ResolvedTarget } from "@/infrastructure/llm/providers";
import { getModelConfig, SELF_HOSTED_PROVIDERS, wireModelId } from "@/domain/llm/models";
import type { ProviderChannelConfig } from "@/infrastructure/llm/providers";
import type { TranscriptionConfig } from "@/infrastructure/llm/transcription";
import { config, positiveIntEnv } from "./config";
import { optionalEnv } from "@/shared/env";
import { parseList } from "@/shared/parseList";
import { decryptSecret } from "@/infrastructure/crypto/secretEncryption";
import {
  llmApiKeyContext,
  llmProviderApiKeyContext,
  settingsSecretContext,
} from "@/domain/security/secretContext";

const DEFAULT_TTL_MS = 5_000;

// A non-positive TTL would either disable caching entirely or (negative) make
// every read a cache hit forever, so the floor is 1ms.
const TTL_MS = positiveIntEnv("SETTINGS_CACHE_TTL_MS", DEFAULT_TTL_MS, 1);

let cache: { value: AppSettings | null; fetchedAt: number } | undefined;
let cacheGeneration = 0;
let pendingRead:
  | { generation: number; promise: Promise<AppSettings | null> }
  | undefined;

async function loadSettings(): Promise<AppSettings | null> {
  const now = Date.now();
  if (!cache || now - cache.fetchedAt > TTL_MS) {
    const generation = cacheGeneration;
    if (pendingRead?.generation === generation) {
      return pendingRead.promise;
    }
    const promise = settingsRepository
      .get()
      .then((value) => {
        if (generation === cacheGeneration) {
          cache = { value, fetchedAt: now };
        }
        return value;
      })
      .finally(() => {
        if (pendingRead?.promise === promise) {
          pendingRead = undefined;
        }
      });
    pendingRead = { generation, promise };
    return promise;
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
  if (stored?.llmBaseUrl !== undefined && stored.llmApiKey === undefined) {
    throw new Error("Stored LLM_BASE_URL has no matching LLM_API_KEY");
  }
  const baseUrl = stored?.llmBaseUrl ?? config.llmBaseUrl;
  return {
    baseUrl,
    apiKey:
      stored?.llmApiKey !== undefined
        ? decryptSecret(stored.llmApiKey, llmApiKeyContext(baseUrl))
        : config.llmApiKey,
  };
}

export async function getEmbeddingChannelConfig(): Promise<{ baseUrl: string; apiKey: string }> {
  if (config.embeddingBaseUrl) {
    return {
      baseUrl: config.embeddingBaseUrl,
      // The OpenAI SDK requires a key even when a local endpoint does not.
      // Never reuse the LLM secret for a separately addressed service.
      apiKey: config.embeddingApiKey ?? "not-required",
    };
  }
  return getLlmChannelConfig();
}

async function getRetrievalProviderTarget(model: string): Promise<ResolvedTarget | undefined> {
  const registered = getModelConfig(model);
  if (!registered || SELF_HOSTED_PROVIDERS.some((name) => name === registered.provider)) {
    return undefined;
  }
  const provider = (await getLlmProviderConfigs()).find((entry) => entry.name === registered.provider);
  if (!provider) {
    return undefined;
  }
  if (provider.auth === "sigv4") {
    throw new Error(`Provider "${provider.name}" does not support OpenAI-compatible retrieval authentication`);
  }
  return resolveProviderTarget(model, [provider], provider);
}

export async function getEmbeddingTarget(model: string): Promise<{ baseUrl: string; apiKey: string; model: string }> {
  return await getRetrievalProviderTarget(model)
    ?? { ...await getEmbeddingChannelConfig(), model: wireModelId(model) };
}

export async function getRerankerTarget(model: string): Promise<{ baseUrl: string; apiKey?: string; model: string }> {
  const provider = await getRetrievalProviderTarget(model);
  if (provider) {
    return provider;
  }
  const reranker = config.reranker;
  if (!reranker) {
    throw new Error("The reranker endpoint is not configured");
  }
  return { ...reranker, model: wireModelId(model) };
}

/** ASR requires an explicit channel; never fall through to an unrelated text provider. */
export async function getTranscriptionTarget(model: string): Promise<TranscriptionConfig & { segmentSeconds: number }> {
  const registered = getModelConfig(model);
  if (!registered?.capabilities.transcription) throw new Error("The selected model is not a registered transcription model");
  const settings = config.transcription;
  let target: { baseUrl: string; apiKey?: string; model: string };
  if (settings.baseUrl) {
    target = { baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: wireModelId(model) };
  } else {
    const provider = (await getLlmProviderConfigs()).find((entry) => entry.name === registered.provider);
    if (!provider || provider.auth === "sigv4") throw new Error("An OpenAI-compatible transcription channel is not configured");
    target = resolveProviderTarget(model, [provider], provider);
  }
  return { baseUrl: target.baseUrl, apiKey: target.apiKey, id: model, wireId: target.model,
    maxInputBytes: settings.maxInputBytes, responseFormat: settings.responseFormat,
    ...(settings.chunkingStrategy ? { chunkingStrategy: settings.chunkingStrategy } : {}),
    segmentSeconds: settings.segmentSeconds };
}

export interface ModelSelection {
  model: string;
  source: "override" | "env" | "default";
}

export interface ScoreSelection {
  value: number;
  source: "override" | "env" | "default";
}

export async function getEmbeddingModelSelection(): Promise<ModelSelection> {
  const stored = (await loadSettings())?.embeddingModel;
  if (stored !== undefined) {
    return { model: stored, source: "override" };
  }
  const fromEnv = optionalEnv(process.env.EMBEDDING_MODEL);
  return fromEnv
    ? { model: fromEnv, source: "env" }
    : { model: config.embeddingModel, source: "default" };
}

export async function getEmbeddingModel(): Promise<string> {
  return (await getEmbeddingModelSelection()).model;
}

export async function getRerankerModelSelection(): Promise<ModelSelection | undefined> {
  const stored = (await loadSettings())?.rerankerModel;
  if (stored !== undefined) {
    return { model: stored, source: "override" };
  }
  const fromEnv = optionalEnv(process.env.RERANKER_MODEL);
  return fromEnv ? { model: fromEnv, source: "env" } : undefined;
}

export async function getRerankerModel(): Promise<string> {
  const selection = await getRerankerModelSelection();
  if (!selection) {
    throw new Error("RERANKER_MODEL not configured");
  }
  return selection.model;
}

export async function getRerankerMinScoreSelection(): Promise<ScoreSelection> {
  const stored = (await loadSettings())?.rerankerMinScore;
  if (stored !== undefined) {
    const value = Number(stored);
    if (Number.isFinite(value) && value >= 0 && value <= 1) {
      return { value, source: "override" };
    }
  }
  return optionalEnv(process.env.RERANKER_MIN_SCORE) !== undefined
    ? { value: config.rerankerMinScore, source: "env" }
    : { value: config.rerankerMinScore, source: "default" };
}

export async function getRerankerMinScore(): Promise<number> {
  return (await getRerankerMinScoreSelection()).value;
}

export async function getLlmProviderConfigs(): Promise<ProviderChannelConfig[]> {
  const stored = (await loadSettings())?.llmProviders;
  if (stored !== undefined) {
    return stored.map((provider) => ({
      name: provider.name,
      baseUrl: provider.baseUrl,
      // A `sigv4` row stores an empty key, which is not ciphertext — decrypting
      // it would be asking the cipher to answer a question it was never given.
      apiKey:
        provider.apiKey === ""
          ? ""
          : decryptSecret(
              provider.apiKey,
              llmProviderApiKeyContext(provider.name, provider.baseUrl),
            ),
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
    token: await getGitHubToken(),
  };
}

export async function getGitHubToken(): Promise<string | undefined> {
  const stored = await loadSettings();
  return stored?.githubToken !== undefined
    ? decryptSecret(stored.githubToken, settingsSecretContext("github-token")) : config.githubToken;
}

export async function getA2aApiKey(): Promise<string | undefined> {
  const stored = (await loadSettings())?.a2aApiKey;
  return stored !== undefined
    ? decryptSecret(stored, settingsSecretContext("a2a-api-key"))
    : config.a2aApiKey;
}

export async function getPublicBaseUrl(): Promise<string | undefined> {
  return (await loadSettings())?.publicBaseUrl ?? config.publicBaseUrl;
}

export async function getArtifactAccessMode(): Promise<ArtifactAccessMode> {
  const value =
    (await loadSettings())?.artifactAccessMode ?? optionalEnv(process.env.ARTIFACT_ACCESS_MODE);
  return value === "public" || value === "proxied" ? value : "authenticated";
}

/**
 * The hidden-model denylist; `undefined` means no restriction. Read at
 * selection time only (the /api/models list) — the run bracket never sees it,
 * so an Agent already holding a hidden model keeps running.
 */
export async function getHiddenModels(): Promise<string[] | undefined> {
  return (await loadSettings())?.hiddenModels;
}

/**
 * The deployment's self-hosted model declarations, as stored; `[]` when none.
 * DB-only — there is no env fallback, because the deployment is the publisher
 * of these and a declaration is data, not configuration. Read by the catalog
 * refresher (boot and every tick) and installed into the registry overlay.
 */
export async function getSelfHostedModels(): Promise<NonNullable<AppSettings["selfHostedModels"]>> {
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

/** Docker compute infrastructure is deployment-owned; project and model settings are stored separately. */
export function getWorkspaceConfig() { return config.workspace; }
export async function getWorkspaceRuntimeConfig(kind: WorkspaceRuntime) {
  if (kind === "command") return {};
  const selected = (await loadSettings())?.workspaceModels?.[kind];
  const model = selected ? getModelConfig(selected) : undefined;
  const channels = await getLlmProviderConfigs();
  const channel = model ? workspaceModelChannel(model, channels) : undefined;
  if (!model || !channel || !workspaceRuntimeModelCompatible(kind, model)) return undefined;
  const target = resolveProviderTarget(model.id, channels, { baseUrl: "", apiKey: "" });
  return withWorkspaceModelChannel(kind, { model: target.model }, channel);
}

export function getWorkspaceGitHubConfig() {
  const settings = config.workspaceGitHub;
  return settings?.auth === "token" ? { ...settings, getToken: async () => {
    const token = await getGitHubToken();
    if (!token) throw new Error("Workspace GitHub account token is not configured");
    return token;
  } } : settings;
}
