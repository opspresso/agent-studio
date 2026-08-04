import { parseList } from "@/shared/parseList";
import { log } from "@/shared/logger";

export type Stage = "local" | "alpha" | "prod";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
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
const BOOT_REQUIRED_ENV = ["LLM_BASE_URL", "LLM_API_KEY", "AES_ENCRYPTION_KEY"] as const;

export function assertRequiredConfig(): void {
  const missing = BOOT_REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

/**
 * Access-control guardrail for deployed stages. An empty ADMIN_EMAILS or
 * ALLOWED_EMAIL_DOMAINS is fail-open — any signed-in user is an admin, and any
 * Google account may sign in — so `alpha`/`prod` refuse to boot until both are
 * set. `local` keeps the fail-open default for zero-config development.
 */
export function assertAccessControlConfig(): void {
  if (config.stage === "local") {
    return;
  }
  const missing: string[] = [];
  if (config.adminEmails.length === 0) {
    missing.push("ADMIN_EMAILS");
  }
  if (config.allowedEmailDomains.length === 0) {
    missing.push("ALLOWED_EMAIL_DOMAINS");
  }
  if (missing.length > 0) {
    throw new Error(
      `STAGE=${config.stage} requires access-control config; set: ${missing.join(", ")}`,
    );
  }
}

/**
 * A non-negative integer setting, falling back to `fallback` on anything else.
 * A misconfigured value degrades to the default with a warning rather than
 * silently disabling a limit — `Number("abc") || 0` would read as "off".
 *
 * Exported for the one other numeric env read (`runtime-settings`' cache TTL),
 * which once kept a near-identical parser of its own; `min` is for values
 * where zero is not a configuration but an off-switch nothing intends.
 */
export function positiveIntEnv(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    log.warn("config", `ignoring invalid ${name}="${raw}"; using ${fallback}`);
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
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    log.warn("config", `ignoring invalid ${name}="${raw}"; using ${fallback}`);
    return fallback;
  }
  const clamped = Math.min(Math.max(value, 0), 1);
  if (clamped !== value) {
    log.warn("config", `${name}="${raw}" is outside 0–1; using ${clamped}`);
  }
  return clamped;
}

export const config = {
  get stage(): Stage {
    const stage = process.env.STAGE ?? "local";
    if (stage !== "local" && stage !== "alpha" && stage !== "prod") {
      throw new Error(`Invalid STAGE: ${stage}`);
    }
    return stage;
  },
  get tableName(): string {
    return process.env.DYNAMODB_TABLE_NAME ?? "agent-studio";
  },
  get dynamodbEndpoint(): string | undefined {
    return process.env.DYNAMODB_ENDPOINT || undefined;
  },
  get awsRegion(): string {
    return process.env.AWS_REGION ?? "ap-northeast-2";
  },
  /** Public-read S3 bucket for generated images. Unset disables image persistence. */
  get imageBucketName(): string | undefined {
    return process.env.S3_BUCKET_NAME || undefined;
  },
  /**
   * The instance managed MCP containers run on, and the registry their images
   * must come from. Both unset means this deployment cannot start containers,
   * and managed servers are simply unavailable — the feature is off rather
   * than half-configured.
   */
  get managedMcpInstanceId(): string | undefined {
    return process.env.MANAGED_MCP_INSTANCE_ID || undefined;
  },
  get managedMcpRegistry(): string | undefined {
    return process.env.MANAGED_MCP_REGISTRY || undefined;
  },
  /**
   * The container managed workloads share a network namespace with — this app's
   * own. Every container has its own 127.0.0.1, so a loopback address only
   * means anything if both ends are in the same namespace.
   *
   * Sharing a namespace means one app instance per host: a container joins
   * exactly one, so a second instance would not see the managed servers at all.
   * The name is also resolved to a container id when the workload starts, so a
   * redeploy strands what is already running — see `reconcile` in
   * `managedMcpUseCases`, which is what puts it back.
   */
  get managedMcpNetworkContainer(): string {
    return process.env.MANAGED_MCP_NETWORK_CONTAINER || "agent-studio";
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
   * Empty means no restriction (fail-open); refused at boot in `alpha`/`prod`
   * by `assertAccessControlConfig`.
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
   * feature is off rather than open. Trimmed because a Kubernetes Secret built
   * from a file routinely carries a trailing newline the header never can —
   * untrimmed, that would 401 every tick forever.
   */
  get scheduleScanToken(): string | undefined {
    return process.env.SCHEDULE_SCAN_TOKEN?.trim() || undefined;
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
    return positiveIntEnv("MAX_CONCURRENT_RUNS_PER_ACTOR", 10);
  },
  get maxConcurrentRunsA2a(): number {
    return positiveIntEnv("MAX_CONCURRENT_RUNS_A2A", 50);
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
   * own freshness hint may ask for. Both `0` are meaningful settings — "do not
   * cache" and "ignore what servers ask for" — so the floor is `0`, not `1`.
   * `src/infrastructure/mcp/discoveryCache.ts` owns how the two combine.
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
   * What a Slack reply carries while it is still being written.
   *
   * The default is a built-in emoji, because a custom name a workspace has not
   * defined renders as its own literal text. A workspace with its own spinner
   * (`:loading:` and friends are common) names it here. Any string works — it is
   * appended to the interim message and dropped by the final edit.
   */
  get slackLoadingIndicator(): string | undefined {
    return process.env.SLACK_LOADING_INDICATOR || undefined;
  },
  /** Shared key for inbound A2A requests (X-A2A-Key). Unset disables the A2A endpoints. */
  get a2aApiKey(): string | undefined {
    return process.env.A2A_API_KEY || undefined;
  },
  /**
   * Public base URL of this deployment (scheme + host). Behind a reverse
   * proxy the request URL reflects the bind address, so externally visible
   * URLs (Slack manifests, OAuth callbacks) must come from configuration.
   */
  get publicBaseUrl(): string | undefined {
    return process.env.PUBLIC_BASE_URL || process.env.BETTER_AUTH_URL || undefined;
  },
  /** GitHub skills source repo, e.g. "opspresso/agent-skills". */
  get skillsRepo(): string | undefined {
    return process.env.SKILLS_REPO || undefined;
  },
  get skillsRepoBranch(): string {
    return process.env.SKILLS_REPO_BRANCH || "main";
  },
  /** GitHub tools source repo, e.g. "opspresso/agent-tools". */
  get toolsRepo(): string | undefined {
    return process.env.TOOLS_REPO || undefined;
  },
  get toolsRepoBranch(): string {
    return process.env.TOOLS_REPO_BRANCH || "main";
  },
  get githubToken(): string | undefined {
    return process.env.GITHUB_TOKEN || undefined;
  },
  get googleClientId(): string {
    return required("GOOGLE_CLIENT_ID");
  },
  get googleClientSecret(): string {
    return required("GOOGLE_CLIENT_SECRET");
  },
};
