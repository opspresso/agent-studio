/** AES-GCM context for one agent's bearer token. */
export function agentApiTokenContext(agentName: string): string {
  return JSON.stringify(["agent", agentName, "api-token"]);
}

export function sourceReferenceContext(agentName: string, id: string): string {
  return JSON.stringify(["agent", agentName, "source-reference", id, "url"]);
}

/** AES-GCM context for one agent's webhook trigger secret. */
export function triggerSecretContext(agentName: string, triggerId: string): string {
  return JSON.stringify(["agent", agentName, "trigger", triggerId, "secret"]);
}

export function slackSecretContext(
  agentName: string,
  field: "bot-token" | "signing-secret",
): string {
  return JSON.stringify(["agent", agentName, "slack", field]);
}

export function telegramSecretContext(
  agentName: string,
  field: "bot-token" | "webhook-secret",
): string {
  return JSON.stringify(["agent", agentName, "telegram", field]);
}

export function teamsSecretContext(agentName: string): string {
  return JSON.stringify(["agent", agentName, "teams", "app-password"]);
}

export function mcpHeadersContext(name: string): string {
  return JSON.stringify(["mcp", name, "headers"]);
}

export function mcpOAuthClientSecretContext(name: string): string {
  return JSON.stringify(["mcp", name, "oauth-client-secret"]);
}

export function managedMcpEnvironmentContext(name: string): string {
  return JSON.stringify(["mcp", name, "environment"]);
}

/** Agent settings retain the same credential identity across ordinary edits. */
export function agentMcpHeadersContext(agentName: string, serverName: string): string {
  return JSON.stringify(["agent", agentName, "configuration", "mcp", serverName]);
}

/** Encryption identity for preserved historical VERSION snapshots. */
export function agentVersionMcpHeadersContext(agentName: string, versionName: string, serverName: string): string {
  return JSON.stringify(["agent", agentName, "version", versionName, "mcp", serverName]);
}

export function mcpConnectionSecretContext(
  agentName: string,
  serverName: string,
  field: "client-secret" | "access-token" | "refresh-token",
): string {
  return JSON.stringify(["agent", agentName, "mcp", serverName, field]);
}

export function mcpOAuthStateContext(state: string): string {
  return JSON.stringify(["mcp-oauth-state", state, "pkce-verifier"]);
}

export function llmProviderApiKeyContext(name: string, baseUrl: string): string {
  return JSON.stringify(["settings", "llm-provider", name, baseUrl, "api-key"]);
}

export function settingsSecretContext(field: "github-token"): string {
  return JSON.stringify(["settings", field]);
}

export function runtimeSessionContext(sessionId: string, ownerEmail: string): string {
  return JSON.stringify(["runtime-session", sessionId, ownerEmail]);
}

export function workspaceCheckpointContext(workspaceId: string, checkpointId: string, index: number): string {
  return JSON.stringify(["workspace", workspaceId, "checkpoint", checkpointId, index]);
}
