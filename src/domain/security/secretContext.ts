/** AES-GCM context for one project's bearer token. */
export function projectApiTokenContext(projectName: string): string {
  return JSON.stringify(["project", projectName, "api-token"]);
}

export function sourceReferenceContext(projectName: string, id: string): string {
  return JSON.stringify(["project", projectName, "source-reference", id, "url"]);
}

/** AES-GCM context for one named inbound A2A client key. */
export function a2aClientKeyContext(name: string): string {
  return JSON.stringify(["a2a-client", name, "token"]);
}

/** AES-GCM context for one project's webhook trigger secret. */
export function triggerSecretContext(projectName: string, triggerId: string): string {
  return JSON.stringify(["project", projectName, "trigger", triggerId, "secret"]);
}

export function slackSecretContext(
  projectName: string,
  field: "bot-token" | "signing-secret",
): string {
  return JSON.stringify(["project", projectName, "slack", field]);
}

export function telegramSecretContext(
  projectName: string,
  field: "bot-token" | "webhook-secret",
): string {
  return JSON.stringify(["project", projectName, "telegram", field]);
}

export function teamsSecretContext(projectName: string): string {
  return JSON.stringify(["project", projectName, "teams", "app-password"]);
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

export function externalAgentHeadersContext(name: string): string {
  return JSON.stringify(["external-agent", name, "headers"]);
}

export function versionMcpHeadersContext(
  projectName: string,
  versionName: string,
  serverName: string,
): string {
  return JSON.stringify(["project", projectName, "version", versionName, "mcp", serverName]);
}

export function mcpConnectionSecretContext(
  projectName: string,
  serverName: string,
  field: "client-secret" | "access-token" | "refresh-token",
): string {
  return JSON.stringify(["project", projectName, "mcp", serverName, field]);
}

export function mcpOAuthStateContext(state: string): string {
  return JSON.stringify(["mcp-oauth-state", state, "pkce-verifier"]);
}

export function llmApiKeyContext(baseUrl: string): string {
  return JSON.stringify(["settings", "llm", baseUrl, "api-key"]);
}

export function llmProviderApiKeyContext(name: string, baseUrl: string): string {
  return JSON.stringify(["settings", "llm-provider", name, baseUrl, "api-key"]);
}

export function settingsSecretContext(field: "github-token" | "a2a-api-key"): string {
  return JSON.stringify(["settings", field]);
}

export function runtimeSessionContext(sessionId: string, ownerEmail: string): string {
  return JSON.stringify(["runtime-session", sessionId, ownerEmail]);
}

export function workspaceCheckpointContext(workspaceId: string, checkpointId: string, index: number): string {
  return JSON.stringify(["workspace", workspaceId, "checkpoint", checkpointId, index]);
}
