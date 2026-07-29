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
 */
function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    log.warn("config", `ignoring invalid ${name}="${raw}"; using ${fallback}`);
    return fallback;
  }
  return value;
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
