/** AES-GCM context for one project's bearer token. */
export function projectApiTokenContext(projectName: string): string {
  return JSON.stringify(["project", projectName, "api-token"]);
}
