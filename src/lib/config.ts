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
  get dynamodbEndpointUrl(): string | undefined {
    return process.env.DYNAMODB_ENDPOINT_URL || undefined;
  },
  get awsRegion(): string {
    return process.env.AWS_REGION ?? "ap-northeast-2";
  },
  /** Public-read S3 bucket for generated images. Unset disables image persistence. */
  get imageBucketName(): string | undefined {
    return process.env.S3_BUCKET_NAME || undefined;
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
   * Empty means no restriction.
   */
  get allowedEmailDomains(): string[] {
    return (process.env.ALLOWED_EMAIL_DOMAINS ?? "")
      .split(",")
      .map((domain) => domain.trim().toLowerCase())
      .filter(Boolean);
  },
  /**
   * Emails allowed to mutate shared registries (ADMIN_EMAILS, comma-separated).
   * Empty means no restriction — any signed-in user may mutate.
   */
  get adminEmails(): string[] {
    return (process.env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean);
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
