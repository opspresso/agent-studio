export type ProjectType = "llm" | "agent" | "image";

/**
 * Per-project API token. Only the SHA-256 hash of the token is stored — the raw
 * value is shown once at creation and never persisted or re-readable.
 */
export interface ProjectApiToken {
  tokenHash: string;
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

export interface Version {
  projectName: string;
  versionName: string;
  systemPrompt: string;
  userPromptTemplate: string;
  model: string;
  fallbackModel?: string;
  parameters: VersionParameters;
  mcpList: string[];
  skillList: string[];
  subagentList: SubagentRef[];
  maxTurn?: number;
  createdAt: string;
}
