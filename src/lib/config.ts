export type Stage = "local" | "alpha" | "prod";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} not configured`);
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
  get dynamodbEndpointUrl(): string | undefined {
    return process.env.DYNAMODB_ENDPOINT_URL || undefined;
  },
  get awsRegion(): string {
    return process.env.AWS_REGION ?? "ap-northeast-2";
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
  get slackBotToken(): string | undefined {
    return process.env.SLACK_BOT_TOKEN || undefined;
  },
  get slackSigningSecret(): string | undefined {
    return process.env.SLACK_SIGNING_SECRET || undefined;
  },
  /** Fallback agent project when a mention does not name one. */
  get slackDefaultProject(): string | undefined {
    return process.env.SLACK_DEFAULT_PROJECT || undefined;
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
