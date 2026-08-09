import type { SlackSuggestedPrompt } from "@/domain/slack/types";

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
   * The display mask computed at generation time, e.g. `ast_••••••••wXyZ`.
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
  /**
   * Slack channel id the notifications are posted to, using this project's own
   * bot. Without it (or without a configured bot) the thresholds still block —
   * a missing notification channel must not disable the guard.
   */
  alertSlackChannel?: string;
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
