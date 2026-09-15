import { DEFAULT_MIN_SCORE, DEFAULT_RERANKER_MIN_SCORE } from "@/domain/catalog/types";
import { MAX_RUN_SLOTS } from "@/domain/execution/runSlot";
import { parseKeyValueList, parseList } from "@/shared/parseList";
import { optionalEnv } from "@/shared/env";
import { log } from "@/shared/logger";
import { decodeAes256Key } from "@/shared/aesKey";
import { parseWorkspaceConfig } from "./workspaceConfig";

export type Stage = "local" | "alpha" | "prod";

function required(name: string): string {
  const value = optionalEnv(process.env[name]);
  if (value === undefined) {
    throw new Error(`${name} not configured`);
  }
  return value;
}

/**
 * Environment variables required for any real operation (LLM dispatch + secret
 * encryption). Validated once at boot (see instrumentation.ts) so a misconfig
 * fails fast instead of surfacing as a 500 on the first request that needs it.
 * Google OAuth creds are intentionally excluded — the local dev-session flow
 * bypasses OAuth.
 */
const BOOT_REQUIRED_ENV = [
  "DATABASE_URL",
  "LLM_BASE_URL",
  "LLM_API_KEY",
  "AES_ENCRYPTION_KEY",
] as const;

export function assertRequiredConfig(): void {
  const missing = BOOT_REQUIRED_ENV.filter((name) => optionalEnv(process.env[name]) === undefined);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
  decodeAes256Key(config.aesEncryptionKey);
  void config.reranker;
}

/**
 * Access-control guardrail for deployed stages. An empty ADMIN_EMAILS is
 * fail-open — every signed-in user becomes an admin of the shared registries and
 * of this app's own settings — so `alpha`/`prod` refuse to boot until it is set.
 * `local` keeps the fail-open default for zero-config development.
 *
 * ALLOWED_EMAIL_DOMAINS is deliberately *not* required: an empty value is the
 * configured unrestricted policy, while `getAllowedEmailDomains` may still
 * narrow it with a stored override.
 */
export function assertAccessControlConfig(): void {
  if (process.env.NODE_ENV === "production" && process.env.STAGE === undefined) {
    throw new Error("NODE_ENV=production requires STAGE to be set explicitly");
  }
  if (config.stage === "local") {
    return;
  }
  if (config.adminEmails.length === 0) {
    throw new Error(`STAGE=${config.stage} requires access-control config; set: ADMIN_EMAILS`);
  }
  const providers = config.authProviders;
  if (!providers.google && !providers.keycloak && !providers.oidc && !providers.password) {
    throw new Error(
      `STAGE=${config.stage} has no way to sign in; set OIDC_ISSUER/OIDC_CLIENT_ID/OIDC_CLIENT_SECRET, ` +
        "KEYCLOAK_ISSUER/KEYCLOAK_CLIENT_ID/KEYCLOAK_CLIENT_SECRET, " +
        "GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET, or AUTH_PASSWORD=true",
    );
  }
}

/**
 * Say once per setting, per value, that a configured value could not be used.
 *
 * These readers are getters, and their callers are hot: a retention window is
 * read on every row write — once per model call for usage — and an MCP cache TTL
 * on every discovery write. One misconfigured variable would put a line in the
 * log for each of them, which buries the message it is trying to deliver in
 * exactly the deployments that most need to read it. Keyed by value as well as
 * name so a setting corrected at runtime still reports its next mistake.
 */
const warnedSettings = new Set<string>();

function warnOnce(name: string, raw: string, message: string): void {
  const key = `${name}=${raw}|${message}`;
  if (warnedSettings.has(key)) {
    return;
  }
  warnedSettings.add(key);
  log.warn("config", message);
}

/** Test seam: forget what has already been reported. */
export function resetConfigWarnings(): void {
  warnedSettings.clear();
}

/**
 * A non-negative integer setting, falling back to `fallback` on anything else.
 * A misconfigured value degrades to the default with a warning rather than
 * silently disabling a limit — `Number("abc") || 0` would read as "off".
 *
 * Exported for the one other numeric env read (`runtime-settings`' cache TTL),
 * which once kept a near-identical parser of its own; `min` is for values
 * where zero is not a configuration but an off-switch nothing intends, and
 * `max` is for a storage or protocol ceiling.
 */
export function positiveIntEnv(
  name: string,
  fallback: number,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const raw = optionalEnv(process.env[name]);
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    warnOnce(name, raw, `ignoring invalid ${name}="${raw}"; using ${fallback}`);
    return fallback;
  }
  return value;
}

/**
 * A `0`–`1` setting. Out of range **clamps** rather than falling back — a rate
 * of `2` means "as much as possible", and refusing it would be pedantry — while
 * a value that is not a number at all has no intent to honour and takes the
 * default. Both say so; a sampling rate that quietly became something else is
 * how a deployment ends up reasoning from traces it never recorded.
 */
export function fractionEnv(name: string, fallback: number): number {
  const raw = optionalEnv(process.env[name]);
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    warnOnce(name, raw, `ignoring invalid ${name}="${raw}"; using ${fallback}`);
    return fallback;
  }
  const clamped = Math.min(Math.max(value, 0), 1);
  if (clamped !== value) {
    warnOnce(name, raw, `${name}="${raw}" is outside 0–1; using ${clamped}`);
  }
  return clamped;
}

export const config = {
  get workspace() { return parseWorkspaceConfig(process.env); },
  get workspaceGitHub() {
    const auth = optionalEnv(process.env.WORKSPACE_GITHUB_AUTH);
    if (auth && auth !== "app" && auth !== "token") throw new Error("Invalid WORKSPACE_GITHUB_AUTH");
    if (auth === "token") {
      if (!config.githubWebUrl) throw new Error("Workspace GitHub web URL is required");
      return { apiUrl: config.githubApiUrl, webUrl: config.githubWebUrl, auth: "token" as const,
        webhookSecret: optionalEnv(process.env.WORKSPACE_GITHUB_WEBHOOK_SECRET),
        internalHosts: parseList(process.env.WORKSPACE_GITHUB_INTERNAL_HOSTS ?? "") };
    }
    const appId = optionalEnv(process.env.WORKSPACE_GITHUB_APP_ID);
    const installationId = optionalEnv(process.env.WORKSPACE_GITHUB_INSTALLATION_ID);
    const privateKey = optionalEnv(process.env.WORKSPACE_GITHUB_PRIVATE_KEY);
    if (!appId && !installationId && !privateKey) return undefined;
    if (!appId || !installationId || !privateKey || !/^\d+$/.test(installationId) || !config.githubWebUrl) throw new Error("Incomplete Workspace GitHub App configuration");
    return { appId, installationId: Number(installationId), privateKey: privateKey.replaceAll("\\n", "\n"),
      apiUrl: config.githubApiUrl, webUrl: config.githubWebUrl,
      webhookSecret: optionalEnv(process.env.WORKSPACE_GITHUB_WEBHOOK_SECRET),
      internalHosts: parseList(process.env.WORKSPACE_GITHUB_INTERNAL_HOSTS ?? ""),
    };
  },
  get stage(): Stage {
    const stage = process.env.STAGE ?? "local";
    if (stage !== "local" && stage !== "alpha" && stage !== "prod") {
      throw new Error(`Invalid STAGE: ${stage}`);
    }
    return stage;
  },
  /**
   * The PostgreSQL connection string; every row this app keeps lives behind
   * it. Optional here and required at boot (`BOOT_REQUIRED_ENV`): the pool is
   * constructed when `lib/auth.ts` is evaluated, which `next build` does
   * while collecting page data with no database in sight, and a pool that
   * has not connected yet costs nothing. The first query without a URL fails
   * — after boot has already refused to start without one.
   */
  get databaseUrl(): string | undefined {
    return optionalEnv(process.env.DATABASE_URL);
  },
  /**
   * Connections one instance holds open. Ten is generous for the request
   * shapes here — a run holds a connection for milliseconds at a time, never
   * across a model call — and small enough that a fleet stays under a default
   * `max_connections` of 100.
   */
  get databasePoolSize(): number {
    return positiveIntEnv("DATABASE_POOL_SIZE", 10, 1);
  },
  get awsRegion(): string {
    return process.env.AWS_REGION ?? "ap-northeast-2";
  },
  /**
   * The bucket holding what runs produce, on any S3-compatible store. Unset
   * disables artifact persistence.
   *
   * `S3_ENDPOINT` names a store other than AWS (MinIO, Garage, Ceph RGW — an
   * on-premises install's own), addressed path-style because a self-hosted
   * endpoint rarely resolves bucket subdomains. Credentials come from the
   * standard `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` pair every S3 client
   * reads, or from the instance role where there is one.
   */
  get objectBucketName(): string | undefined {
    return optionalEnv(process.env.S3_BUCKET_NAME);
  },
  get transcription() {
    const baseUrl = optionalEnv(process.env.TRANSCRIPTION_BASE_URL);
    const apiKey = optionalEnv(process.env.TRANSCRIPTION_API_KEY);
    if (apiKey && !baseUrl) throw new Error("TRANSCRIPTION_API_KEY requires TRANSCRIPTION_BASE_URL");
    const responseFormat = optionalEnv(process.env.TRANSCRIPTION_RESPONSE_FORMAT) ?? "json";
    if (responseFormat !== "json" && responseFormat !== "verbose_json" && responseFormat !== "diarized_json") {
      throw new Error("Invalid TRANSCRIPTION_RESPONSE_FORMAT");
    }
    const chunkingStrategy = optionalEnv(process.env.TRANSCRIPTION_CHUNKING_STRATEGY);
    if (chunkingStrategy && chunkingStrategy !== "auto") throw new Error("Invalid TRANSCRIPTION_CHUNKING_STRATEGY");
    return {
      baseUrl, apiKey, responseFormat,
      ...(chunkingStrategy ? { chunkingStrategy: "auto" as const } : {}),
      maxInputBytes: positiveIntEnv("TRANSCRIPTION_MAX_INPUT_BYTES", 25 * 1024 * 1024),
      segmentSeconds: positiveIntEnv("TRANSCRIPTION_SEGMENT_SECONDS", 300),
      ffmpegPath: optionalEnv(process.env.FFMPEG_PATH) ?? "ffmpeg",
      searchPath: process.env.PATH,
    } as const;
  },
  get s3Endpoint(): string | undefined {
    return optionalEnv(process.env.S3_ENDPOINT);
  },
  /**
   * The object store's own key pair (`S3_ACCESS_KEY_ID` /
   * `S3_SECRET_ACCESS_KEY`). Unset falls back to the SDK's default chain —
   * the `AWS_*` pair, an instance role — which is right for AWS itself. A
   * MinIO's key must not sit in `AWS_ACCESS_KEY_ID`: that is the pair every
   * other AWS client in the process reads, and a deployment that also signs
   * Bedrock requests would be sending MinIO's key to AWS.
   */
  get s3Credentials(): { accessKeyId: string; secretAccessKey: string } | undefined {
    const accessKeyId = optionalEnv(process.env.S3_ACCESS_KEY_ID);
    const secretAccessKey = optionalEnv(process.env.S3_SECRET_ACCESS_KEY);
    return accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined;
  },
  /**
   * The base readers reach public objects at, when it differs from the
   * endpoint the app uploads through — a MinIO behind a reverse proxy, say.
   * Unset derives it from the endpoint (or AWS's virtual-host form).
   */
  get s3PublicBaseUrl(): string | undefined {
    return optionalEnv(process.env.S3_PUBLIC_BASE_URL);
  },
  /**
   * Whether this deployment keeps a capability catalog (`CATALOG_ENABLED`).
   *
   * Off means indexing refuses and a run resolves exactly the bindings its
   * version names, which is what every run did before. Off by default because
   * the catalog needs an embedding model the deployment's channel can serve
   * — a self-hosted router without one would index nothing and say so only
   * in a log line — so turning it on is a statement that there is one. The
   * vectors live in the database (`catalog_vectors`); nothing else to point at.
   */
  get catalogEnabled(): boolean {
    return optionalEnv(process.env.CATALOG_ENABLED) === "true";
  },
  /**
   * Which service embeds. `bedrock` needs no credentials of its own — the pod
   * role carries `bedrock:InvokeModel` — while `openai` reuses the chat
   * channel's base URL and key.
   *
   * Anything unrecognised falls back to `openai` rather than throwing: an
   * embedding provider is not worth refusing to boot over, and a deployment
   * with the catalog off never reaches either adapter.
   */
  get embeddingProvider(): "cohere" | "bedrock" | "openai" {
    const raw = optionalEnv(process.env.EMBEDDING_PROVIDER)?.toLowerCase();
    return raw === "cohere" || raw === "bedrock" ? raw : "openai";
  },
  /**
   * The embedding model, whose dimension must equal the index's. Changing it
   * means rebuilding the index: vectors from two models are not comparable, and
   * nothing in a mixed index would report that — the scores would simply be
   * wrong.
   */
  get embeddingModel(): string {
    const configured = optionalEnv(process.env.EMBEDDING_MODEL);
    if (configured) {
      return configured;
    }
    switch (config.embeddingProvider) {
      // The inference profile, not the bare model id — Cohere v4 refuses
      // on-demand invocation by id outright.
      case "cohere":
        return "global.cohere.embed-v4:0";
      case "bedrock":
        return "amazon.titan-embed-text-v2:0";
      default:
        return "text-embedding-3-small";
    }
  },
  /**
   * A dedicated OpenAI-compatible embedding channel. When absent, the default
   * LLM channel remains the endpoint and credential source.
   */
  get embeddingBaseUrl(): string | undefined {
    return optionalEnv(process.env.EMBEDDING_BASE_URL);
  },
  get embeddingApiKey(): string | undefined {
    return optionalEnv(process.env.EMBEDDING_API_KEY);
  },
  /**
   * How many dimensions to ask the model for, or undefined for its native width.
   *
   * Providers that serve several widths need an explicit value — `text-
   * embedding-3-small` is natively 1536. `native` omits the parameter for a
   * model that does not expose a dimension choice. Every row still has to use
   * one width, so changing either form requires a reindex.
   */
  get embeddingDimensions(): number | undefined {
    if (optionalEnv(process.env.EMBEDDING_DIM)?.toLowerCase() === "native") {
      return undefined;
    }
    return positiveIntEnv("EMBEDDING_DIM", 1024, 1);
  },
  /**
   * The catalog's relevance floor, in `[0, 1]`. Belongs to the **embedding
   * model** rather than to the search: measured on Titan v2 a correct answer
   * scores 0.34–0.41 and an unrelated one under 0.12, and a threshold tuned for
   * a model whose correct answers sit near 0.8 would return nothing at all.
   * Changing `EMBEDDING_MODEL` means re-measuring this — the same warning
   * `mcp-memory` carries on `RECALL_MIN_SIMILARITY`.
   */
  get catalogMinScore(): number {
    return fractionEnv("CATALOG_MIN_SCORE", DEFAULT_MIN_SCORE);
  },
  /** A configured reranker is optional, but a partial pair is an error. */
  get reranker(): { baseUrl: string; apiKey?: string; model: string } | undefined {
    const baseUrl = optionalEnv(process.env.RERANKER_BASE_URL);
    const model = optionalEnv(process.env.RERANKER_MODEL);
    if (!baseUrl && !model) {
      return undefined;
    }
    if (!baseUrl || !model) {
      throw new Error("RERANKER_BASE_URL and RERANKER_MODEL must be configured together");
    }
    const apiKey = optionalEnv(process.env.RERANKER_API_KEY);
    return { baseUrl, ...(apiKey ? { apiKey } : {}), model };
  },
  get rerankerMinScore(): number {
    return fractionEnv("RERANKER_MIN_SCORE", DEFAULT_RERANKER_MIN_SCORE);
  },
  /**
   * How managed MCP containers are started (`MANAGED_MCP_RUNTIME=docker`, the
   * one runtime there is — the app drives the Docker CLI on its own host), and
   * the registry configuration required to enable the feature. Docker uses
   * host credentials; this setting does not restrict image registries. Either unset means this
   * deployment cannot start containers, and managed servers are simply
   * unavailable — the feature is off rather than half-configured.
   */
  get managedMcpRuntime(): "docker" | undefined {
    const raw = optionalEnv(process.env.MANAGED_MCP_RUNTIME);
    if (raw === undefined) {
      return undefined;
    }
    if (raw !== "docker") {
      warnOnce("MANAGED_MCP_RUNTIME", raw, `ignoring unknown MANAGED_MCP_RUNTIME="${raw}"; managed MCP is off`);
      return undefined;
    }
    return raw;
  },
  get managedMcpRegistry(): string | undefined {
    return optionalEnv(process.env.MANAGED_MCP_REGISTRY);
  },
  get llmBaseUrl(): string {
    return required("LLM_BASE_URL");
  },
  get llmApiKey(): string {
    return required("LLM_API_KEY");
  },
  get aesEncryptionKey(): string {
    return required("AES_ENCRYPTION_KEY");
  },
  /**
   * Email domains allowed to sign in (ALLOWED_EMAIL_DOMAINS, comma-separated).
   * Empty means no restriction (fail-open) in every stage.
   */
  get allowedEmailDomains(): string[] {
    return parseList(process.env.ALLOWED_EMAIL_DOMAINS ?? "");
  },
  /**
   * Emails allowed to mutate shared registries (ADMIN_EMAILS, comma-separated).
   * Empty means no restriction — any signed-in user may mutate (fail-open);
   * refused at boot in `alpha`/`prod` by `assertAccessControlConfig`.
   */
  get adminEmails(): string[] {
    return parseList(process.env.ADMIN_EMAILS ?? "");
  },
  /**
   * IPs or CIDR ranges of the reverse proxies this deployment sits behind
   * (TRUSTED_PROXY_CIDRS, comma-separated). Better Auth resolves the client IP
   * for its per-IP rate limiting by stripping these hops from the right of
   * X-Forwarded-For; without them a multi-hop chain (ALB + Istio gateway both
   * append) is untrusted and every request shares one rate-limit bucket.
   * Empty leaves Better Auth's single-hop default.
   */
  get trustedProxyCidrs(): string[] {
    return parseList(process.env.TRUSTED_PROXY_CIDRS ?? "");
  },
  /**
   * The token the schedule ticker presents (SCHEDULE_SCAN_TOKEN). Unset means
   * this deployment has no ticker and the scan endpoint answers 503 — the
   * feature is off rather than open. The trim `optionalEnv` applies is what
   * this setting needed first: a Kubernetes Secret built from a file routinely
   * carries a trailing newline the header never can, and untrimmed that would
   * 401 every tick forever.
   */
  get scheduleScanToken(): string | undefined {
    return optionalEnv(process.env.SCHEDULE_SCAN_TOKEN);
  },
  /**
   * How many runs one caller may have in flight at once, and the separate
   * ceiling for inbound A2A.
   *
   * A2A needs its own because its actor id is a constant — the inbound key is
   * shared, so one identity stands for every machine caller and the per-caller
   * limit would become a cap on the whole A2A surface.
   *
   * Both are on by default. The default is generous enough that a person with
   * several chats open never meets it, while still bounding a loop; `0` turns
   * the limit off, which is a choice a deployment has to make explicitly rather
   * than inherit from an unset variable.
   */
  get maxConcurrentRunsPerActor(): number {
    return positiveIntEnv("MAX_CONCURRENT_RUNS_PER_ACTOR", 10, 0, MAX_RUN_SLOTS);
  },
  get maxConcurrentRunsA2a(): number {
    return positiveIntEnv("MAX_CONCURRENT_RUNS_A2A", 50, 0, MAX_RUN_SLOTS);
  },
  /**
   * The share of predict and image runs that record a trace. Agent runs are
   * always traced — that is a decision in `traceLifecycle`, not a rate.
   */
  get traceSampleRate(): number {
    return fractionEnv("TRACE_SAMPLE_RATE", 0.1);
  },
  /**
   * How long a discovered MCP tool list may be reused, and the most a server's
   * own freshness hint (SEP-2549) may ask for. Both `0` are meaningful settings
   * — "do not cache" and "ignore what servers ask for" — so the floor is `0`,
   * not `1`. `src/infrastructure/mcp/discoveryCache.ts` owns how the two
   * combine.
   *
   * The ceiling is a separate knob rather than a larger local TTL because the
   * entry's lifetime answers two questions that want different numbers. The
   * server's hint answers the first — how long its catalogue stays fresh — and
   * it knows that better than we do. The same number bounds the second:
   * `invalidateMcpDiscovery` is process-local, so on a multi-instance deployment
   * it is how long a registry edit made on one instance goes unseen on the
   * others, and a server asking for an hour would decide that for the whole
   * fleet. Raising the local TTL instead would also stop *unhinted* servers
   * being re-read, which is the opposite trade. Single-instance deployments can
   * raise the ceiling freely; multi-instance ones should keep it near the
   * staleness they are willing to wear.
   */
  get mcpDiscoveryCacheTtlMs(): number {
    return positiveIntEnv("MCP_DISCOVERY_CACHE_TTL_MS", 60_000);
  },
  get mcpMaxServerTtlMs(): number {
    return positiveIntEnv("MCP_MAX_SERVER_TTL_MS", 5 * 60_000);
  },
  /**
   * DNS suffixes whose hosts an MCP entry may use despite resolving privately —
   * a Kubernetes Service name, typically `.<namespace>.svc.cluster.local`.
   *
   * The SSRF guard rejects private addresses, correctly, because its job is to
   * stop a typed or model-chosen URL from reaching an internal service. On a
   * cluster the servers this app is *meant* to call are internal by
   * construction, so there has to be a way to say which ones — and it has to be
   * this one: deployment configuration, not something a registry entry can
   * claim for itself. Env-only for the same reason it is not in runtime
   * settings: widening the outbound boundary should take a deploy, not a form.
   *
   * Empty (the default) leaves the guard exactly as it was.
   */
  get mcpInternalHostSuffixes(): string[] {
    return parseList(process.env.MCP_INTERNAL_HOST_SUFFIXES ?? "");
  },
  /**
   * DNS suffixes whose hosts the `FetchUrl` builtin may read despite resolving
   * privately — an on-premises wiki or an internal API, on a network where what
   * a model should be allowed to read is private by construction.
   *
   * A *separate* list from `MCP_INTERNAL_HOST_SUFFIXES`, on purpose. That one
   * names services this app is meant to call; this one names pages a model may
   * be talked into reading, and a prompt injection must not be able to read a
   * cluster-internal MCP service because a deploy declared it reachable for a
   * different reason. Same matching (`isDeclaredInternalHost`), same caveats —
   * no IP literals, no single-label suffixes except exact localhost — and
   * env-only for the same reason:
   * widening what a model-chosen URL can reach should take a deploy, not a form.
   *
   * Empty (the default) leaves every model-chosen URL facing the guard.
   */
  get urlFetchInternalHostSuffixes(): string[] {
    return parseList(process.env.URL_FETCH_INTERNAL_HOST_SUFFIXES ?? "");
  },
  /**
   * Accept an OAuth authorization server that does not advertise PKCE. The
   * spec says a client MUST refuse one; a server that supports PKCE without
   * saying so is common enough that an operator may decide to accept the
   * downgrade risk for their deployment — once, here, never per entry.
   */
  get mcpOauthAllowUnadvertisedPkce(): boolean {
    return optionalEnv(process.env.MCP_OAUTH_ALLOW_UNADVERTISED_PKCE) === "true";
  },
  /**
   * What a Slack reply carries while it is still being written.
   *
   * The default is a built-in emoji, because a custom name a workspace has not
   * defined renders as its own literal text. A workspace with its own spinner
   * (`:loading:` and friends are common) names it here. Any string works — it is
   * appended to the interim message and dropped by the final edit.
   */
  get slackLoadingIndicator(): string | undefined {
    return optionalEnv(process.env.SLACK_LOADING_INDICATOR);
  },
  /** Shared key for inbound A2A requests (X-A2A-Key). Unset disables the A2A endpoints. */
  get a2aApiKey(): string | undefined {
    return optionalEnv(process.env.A2A_API_KEY);
  },
  /**
   * OTLP HTTP endpoint finished traces are exported to, standard OTEL name.
   * Unset means no export at all — the decorator is simply not applied.
   */
  get otelExporterEndpoint(): string | undefined {
    return optionalEnv(process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
  },
  /**
   * OTLP headers in the standard `key=value,key2=value2` form. Case-preserving
   * on purpose — the values are collector credentials, and `parseList`'s
   * lowercasing would quietly corrupt a bearer token into one every request
   * gets a 401 for.
   */
  get otelExporterHeaders(): Record<string, string> | undefined {
    const headers = parseKeyValueList(process.env.OTEL_EXPORTER_OTLP_HEADERS ?? "");
    return Object.keys(headers).length > 0 ? headers : undefined;
  },
  /**
   * Public base URL of this deployment (scheme + host). Behind a reverse
   * proxy the request URL reflects the bind address, so externally visible
   * URLs (Slack manifests, OAuth callbacks) must come from configuration.
   */
  get publicBaseUrl(): string | undefined {
    return optionalEnv(process.env.PUBLIC_BASE_URL) ?? optionalEnv(process.env.BETTER_AUTH_URL);
  },
  /**
   * Where the model registry is published — agent-models' catalog. Fetched at
   * boot and on `modelsCatalogRefreshMs`; the committed snapshot
   * (`src/domain/llm/catalog.json`) serves until then and whenever the fetch
   * fails.
   *
   * Unset or `none` (case-insensitive) turns the remote read off altogether
   * and is answered as `undefined`: no fetch at boot, none on the interval,
   * and no warning about a site that was never configured. The catalog is
   * then the snapshot or the document an admin uploads
   * (`PUT /api/models/catalog/document`). The interval itself stays on,
   * since it is also how an upload on another instance and a self-hosted
   * declaration reach this process; without a URL a tick reads the database
   * and nothing else.
   */
  get modelsCatalogUrl(): string | undefined {
    const value = optionalEnv(process.env.MODELS_CATALOG_URL);
    return value === undefined || value.toLowerCase() === "none" ? undefined : value;
  },
  /** How often the catalog is re-read; 0 disables the interval (the boot read still happens). */
  get modelsCatalogRefreshMs(): number {
    return positiveIntEnv("MODELS_CATALOG_REFRESH_MS", 60 * 60 * 1000);
  },
  /** GitHub Agent Plugins source repo, e.g. "opspresso/agent-plugins". */
  get pluginsRepo(): string | undefined {
    return optionalEnv(process.env.PLUGINS_REPO);
  },
  get pluginsRepoBranch(): string {
    return optionalEnv(process.env.PLUGINS_REPO_BRANCH) ?? "main";
  },
  get githubToken(): string | undefined {
    return optionalEnv(process.env.GITHUB_TOKEN);
  },
  /**
   * Where the GitHub REST API answers — `https://api.github.com` unless a
   * GitHub Enterprise Server or a mirror stands in for it (`https://<host>/api/v3`).
   * A trailing slash is dropped so the client's `/repos/...` paths join cleanly.
   */
  get githubApiUrl(): string {
    return (optionalEnv(process.env.GITHUB_API_URL) ?? "https://api.github.com").replace(/\/+$/, "");
  },
  /**
   * Browser-facing GitHub base. Public GitHub and the standard GHES `/api/v3`
   * shape are derivable; a mirror or non-standard layout must name its web UI.
   */
  get githubWebUrl(): string | undefined {
    const explicit = optionalEnv(process.env.GITHUB_WEB_URL);
    if (explicit) {
      try {
        const url = new URL(explicit);
        return url.protocol === "https:" || url.protocol === "http:"
          ? `${url.origin}${url.pathname.replace(/\/+$/, "")}`
          : undefined;
      } catch {
        return undefined;
      }
    }
    if (config.githubApiUrl === "https://api.github.com") {
      return "https://github.com";
    }
    try {
      const api = new URL(config.githubApiUrl);
      const suffix = "/api/v3";
      if (
        (api.protocol !== "https:" && api.protocol !== "http:") ||
        !api.pathname.endsWith(suffix)
      ) {
        return undefined;
      }
      return `${api.origin}${api.pathname.slice(0, -suffix.length)}`;
    } catch {
      return undefined;
    }
  },
  /**
   * The ways a person may sign in. Every one is optional, because an
   * installation decides which identity provider it has: a standard OIDC
   * provider (Keycloak, Entra ID, Okta, Authentik — anything with a discovery
   * document), Google, or a local password — which exists for the first
   * administrator of an installation with no identity provider reachable yet,
   * and for break-glass access when the provider is down.
   */
  get googleOAuth(): { clientId: string; clientSecret: string } | undefined {
    const clientId = optionalEnv(process.env.GOOGLE_CLIENT_ID);
    const clientSecret = optionalEnv(process.env.GOOGLE_CLIENT_SECRET);
    return clientId && clientSecret ? { clientId, clientSecret } : undefined;
  },
  get keycloak(): { issuer: string; clientId: string; clientSecret: string } | undefined {
    const issuer = optionalEnv(process.env.KEYCLOAK_ISSUER);
    const clientId = optionalEnv(process.env.KEYCLOAK_CLIENT_ID);
    const clientSecret = optionalEnv(process.env.KEYCLOAK_CLIENT_SECRET);
    if (!issuer || !clientId || !clientSecret) {
      return undefined;
    }
    try {
      const url = new URL(issuer);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error("invalid issuer");
      }
    } catch {
      throw new Error("KEYCLOAK_ISSUER must be an HTTP(S) realm URL without credentials, query, or fragment");
    }
    return { issuer: issuer.replace(/\/+$/, ""), clientId, clientSecret };
  },
  get oidc():
    | { issuer: string; clientId: string; clientSecret: string; displayName: string; scopes: string[] }
    | undefined {
    const issuer = optionalEnv(process.env.OIDC_ISSUER);
    const clientId = optionalEnv(process.env.OIDC_CLIENT_ID);
    const clientSecret = optionalEnv(process.env.OIDC_CLIENT_SECRET);
    if (!issuer || !clientId || !clientSecret) {
      return undefined;
    }
    return {
      issuer: issuer.replace(/\/+$/, ""),
      clientId,
      clientSecret,
      displayName: optionalEnv(process.env.OIDC_DISPLAY_NAME) ?? "SSO",
      scopes: (optionalEnv(process.env.OIDC_SCOPES) ?? "openid email profile").split(/\s+/),
    };
  },
  get passwordAuth(): boolean {
    return optionalEnv(process.env.AUTH_PASSWORD) === "true";
  },
  /**
   * An administrator account created on first boot when password sign-in is
   * on and no user with that email exists. The email should also be in
   * `ADMIN_EMAILS` — the account is an ordinary user otherwise.
   */
  get bootstrapAdmin(): { email: string; password: string } | undefined {
    const email = optionalEnv(process.env.BOOTSTRAP_ADMIN_EMAIL);
    const password = optionalEnv(process.env.BOOTSTRAP_ADMIN_PASSWORD);
    return email && password ? { email, password } : undefined;
  },
  /** What the sign-in page offers — the providers above, as switches. */
  get authProviders(): { google: boolean; keycloak: boolean; oidc: { displayName: string } | undefined; password: boolean } {
    const oidc = config.oidc;
    return {
      google: config.googleOAuth !== undefined,
      keycloak: config.keycloak !== undefined,
      oidc: oidc ? { displayName: oidc.displayName } : undefined,
      password: config.passwordAuth,
    };
  },
};
