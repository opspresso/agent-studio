export type ProjectType = "llm" | "agent" | "image";

/**
 * Per-project API token. Only the SHA-256 hash of the token is stored — the raw
 * value is shown once at creation and never persisted or re-readable.
 */
export interface ProjectApiToken {
  tokenHash: string;
  /**
   * The display mask computed at generation time, e.g. `ast_••••••••wXyZ`.
   * Stored rather than derived because the token itself is unrecoverable: this
   * is the only way the console can show *which* token is set. It holds nothing
   * beyond the prefix and the few edge characters a mask reveals, so it cannot
   * be used to reconstruct the token. Absent on tokens issued before masks were
   * displayed.
   */
  masked?: string;
  createdAt: string;
}

/** Per-project Slack bot credentials. Secrets are AES-encrypted at rest. */
export interface SlackIntegration {
  botToken: string;
  signingSecret: string;
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
  createdAt: string;
  updatedAt: string;
}

export interface VersionParameters {
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: "low" | "medium" | "high";
  piiFiltering: boolean;
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
