import type { SlackSuggestedPrompt } from "@/domain/slack/types";
import type { MessageDestination } from "@/domain/messaging/destination";

export type ProjectType = "llm" | "agent" | "image";

/**
 * Per-project API token. The token is stored AES-256-GCM encrypted so the owner
 * can read it back in the console — a deliberate trade: unlike a hash, stored
 * ciphertext is usable by anyone who obtains both the table and the encryption
 * key. Exactly one of the two forms below is present.
 */
export interface ProjectApiToken {
  /** The token, `enc:v1:`-encrypted. Decryptable by the owner-gated read path. */
  token?: string;
  /**
   * SHA-256 hash — the only form tokens issued before revealing existed have.
   * Verification still accepts them; they can never be shown again, so the
   * console offers regeneration instead.
   */
  tokenHash?: string;
  /**
   * The display mask computed at generation time, e.g. `adt_••••••••wXyZ`.
   * Stored rather than derived so a hash-only token can still be identified,
   * and so listing one costs no decryption. It holds nothing beyond the prefix
   * and the few edge characters a mask reveals. Absent on tokens issued before
   * masks were displayed.
   */
  masked?: string;
  createdAt: string;
}

/** Per-project Slack bot credentials. Secrets are AES-encrypted at rest. */
export interface SlackIntegration {
  botToken: string;
  signingSecret: string;
  enabled: boolean;
  /**
   * What the agent offers when a user opens it. Not a secret — stored, returned
   * and rendered in the clear, unlike the two credentials above. Absent means
   * the agent surface offers nothing beyond its description.
   */
  suggestedPrompts?: SlackSuggestedPrompt[];
  /**
   * Words that wake the bot in a channel without a mention.
   *
   * Not a secret either, and empty by default: the bot receives every message
   * in the channels it belongs to, and a project that names nothing here
   * answers only mentions and follow-ups in threads it is already part of.
   */
  channelKeywords?: string[];
}

/**
 * Spend guards for one project, over two UTC windows — the day and the month.
 * Every threshold is optional and independent: a project may warn without ever
 * blocking, or block without warning first. Absent means no limit — the shape
 * every project had before.
 *
 * The day is the grain the usage row is keyed at
 * (`USAGE#{project} / DATE#{yyyy-MM-dd}`); the month needs no aggregate of its
 * own, because it is at most 31 of those rows in one partition.
 */
export interface CostLimits {
  /** Notify once when the day's spend reaches this, but keep running. */
  alertThresholdUsd?: number;
  /** Refuse further runs for the rest of the UTC day once spend reaches this. */
  blockThresholdUsd?: number;
  /** Notify once when the UTC month's spend reaches this, but keep running. */
  monthlyAlertThresholdUsd?: number;
  /**
   * Refuse further runs for the rest of the UTC month once spend reaches this.
   * The month's spend is the sum of its daily rows — at most 31 in one
   * partition, one bounded query — so no separate aggregate exists to drift.
   */
  monthlyBlockThresholdUsd?: number;
  /** Application-owned notifications, at most one destination per platform. */
  alertDestinations?: MessageDestination[];
  /**
   * Legacy Slack destination. Read when `alertDestinations` is absent and
   * removed on the next settings save.
   */
  alertSlackChannel?: string;
}

/** Current destinations, with legacy Slack-only settings read compatibly. */
export function costAlertDestinations(limits: CostLimits): MessageDestination[] {
  if (limits.alertDestinations !== undefined) {
    return limits.alertDestinations;
  }
  return limits.alertSlackChannel
    ? [{ kind: "slack", channelId: limits.alertSlackChannel }]
    : [];
}

/**
 * Per-project Telegram bot credentials. Secrets are AES-encrypted at rest.
 *
 * A bot token identifies the bot to Telegram; the webhook secret is what
 * Telegram echoes back on every delivery (`X-Telegram-Bot-Api-Secret-Token`),
 * so it is the whole authentication of the events endpoint. Both are this
 * platform's to keep — the token is Telegram's, the secret is minted here.
 */
export interface TelegramIntegration {
  botToken: string;
  webhookSecret: string;
  enabled: boolean;
  /**
   * The bot's `@username`, learned from `getMe` when the token was saved. Not a
   * secret. It is what tells a mention of *this* bot in a group from a mention
   * of anyone else, and a group message that names nobody from one that names
   * it — a bot receives both, and only the username separates them.
   */
  botUsername?: string;
}

/**
 * Per-project Microsoft Teams bot credentials — an Azure Bot registration.
 * Secrets are AES-encrypted at rest.
 *
 * The App ID is what the Bot Framework names as the audience of every token it
 * signs a delivery with, and the password is what this platform trades for a
 * token to answer with. Nothing is minted here: both come from Azure, and the
 * messaging endpoint is registered there by the operator, not by this
 * platform — Azure offers no call for it.
 */
export interface TeamsIntegration {
  appId: string;
  appPassword: string;
  /** A single-tenant registration's tenant id; absent for a multi-tenant app. */
  tenantId?: string;
  enabled: boolean;
}

export interface Project {
  name: string;
  displayName: string;
  description: string;
  projectType: ProjectType;
  ownerEmail: string;
  departmentCode?: string;
  publishedVersion?: string;
  slack?: SlackIntegration;
  telegram?: TelegramIntegration;
  teams?: TeamsIntegration;
  costLimits?: CostLimits;
  createdAt: string;
  updatedAt: string;
}

export interface VersionParameters {
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: "low" | "medium" | "high";
  piiFiltering: boolean;
  /**
   * Whether the run is told who is asking (name, timezone, avatar URL — never
   * an email). Opt-in because it puts a real person's name into the prompt,
   * which PII filtering does not mask.
   */
  callerContext?: boolean;
  structuredOutput?: boolean;
  jsonSchema?: Record<string, unknown>;
  imageGeneration?: boolean;
  imageModel?: string;
  /**
   * Whether this version's runs may read an address the model names.
   *
   * Off by default. Every other outbound request goes to a URL an operator
   * registered; this one goes wherever the model says, and a model is talked
   * into things by the text it reads.
   */
  urlFetch?: boolean;
  /**
   * Whether this version's runs may read the Slack workspace its project's bot
   * is installed in — channel history, threads, who a user id is.
   *
   * Off by default, and opt-in for the same reason `urlFetch` is: it widens
   * what a run can reach rather than how it answers. Projects are a shared
   * catalog, so anyone who can run this project can read anything the bot can —
   * which is every channel it was invited to. Inert without a configured,
   * enabled Slack bot on the project.
   *
   * Read-only. `chat:write` is granted to the bot for its replies and is
   * deliberately not reachable from a tool.
   */
  slackWorkspace?: boolean;
  /**
   * Whether a run may reach capabilities this version did not bind, found by
   * searching the global catalog with this version's system prompt and the
   * request being answered.
   *
   * Opt-in, and off for everything written before it existed, because it is the
   * one parameter that changes what a run *can do* rather than how it does it.
   * A version is a snapshot of configuration; silently widening what an existing
   * one reaches would make its past traces describe a different agent.
   *
   * What it adds is strictly additive: bindings are resolved first and in full,
   * and nothing found by search can displace or truncate them.
   */
  dynamicCapabilities?: boolean;
  /**
   * Whether a run asks its memory before the first token.
   *
   * A memory server (mcp-memory) keeps what outlives a run, and it can only be
   * read through a tool — so the model has to remember to ask, and a run that
   * did not starts from nothing. With this on, the run calls `recall` on every
   * bound MCP server that offers one, with the newest user turn as the query,
   * and puts what came back into the system prompt ahead of the conversation.
   * The tools stay offered as before; this adds the read the model would
   * otherwise have to think of.
   *
   * Opt-in, for the same reason `dynamicCapabilities` is: it sends the request
   * text to a server before the model has said anything, and it costs one call
   * per run. Inert when no bound server offers `recall`, which the run reports.
   */
  memoryRecall?: boolean;
}

export interface SubagentRef {
  name: string;
  type: "local" | "remote";
}

/**
 * A version's binding to a registry MCP server. The URL always comes from the
 * registry; only headers may be redefined per version.
 *
 * `headers` layers over the registry server's own headers at dispatch:
 * a string value replaces a registry default or adds a new header, and `null`
 * removes a registry default. Matching is case-insensitive, as HTTP header
 * names are. Values are AES-encrypted at rest and masked on read exactly like
 * the registry's headers.
 */
export interface McpBinding {
  name: string;
  headers?: Record<string, string | null>;
  /**
   * Which of the server's tools this version offers the model. Absent means all
   * of them — the shape every binding had before, and the right default for a
   * small server. A large server is worth narrowing: every tool costs prompt
   * budget and dilutes the model's choice.
   */
  tools?: string[];
}

export interface Version {
  projectName: string;
  versionName: string;
  systemPrompt: string;
  userPromptTemplate: string;
  model: string;
  fallbackModel?: string;
  parameters: VersionParameters;
  /** Bound MCP servers. Legacy rows stored plain names; reads normalize them. */
  mcpList: McpBinding[];
  skillList: string[];
  subagentList: SubagentRef[];
  maxTurn?: number;
  createdAt: string;
}
