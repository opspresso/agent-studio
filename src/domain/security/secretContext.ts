/** AES-GCM context for one project's bearer token. */
export function projectApiTokenContext(projectName: string): string {
  return JSON.stringify(["project", projectName, "api-token"]);
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
