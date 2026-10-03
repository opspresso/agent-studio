import type { RunUser } from "@/domain/execution/actor";
import type { Agent } from "@/domain/agent/types";
import type { McpRepository } from "@/domain/mcp/repository";
import type { McpAuthProvider } from "@/domain/mcp/oauth";
import type { McpServerAuth } from "@/domain/mcp/types";
import { mcpAccountProvider } from "@/domain/mcp/account";
import { ValidationError } from "@/application/errors";

interface GitHubCredentialDeps {
  authorize(agentName: string, user: RunUser): Promise<Agent>;
  mcps: Pick<McpRepository, "get">;
  auth: McpAuthProvider;
  target: { apiUrl: string; webUrl: string };
}

/** GitHub OAuth credentials may only reach the GitHub authority that issued them. */
function githubAuthority(auth: McpServerAuth, target: GitHubCredentialDeps["target"]): boolean {
  if (mcpAccountProvider(auth) === "github") {
    return target.apiUrl.replace(/\/$/, "") === "https://api.github.com" && target.webUrl.replace(/\/$/, "") === "https://github.com";
  }
  const web = target.webUrl.replace(/\/$/, "");
  return target.apiUrl.replace(/\/$/, "") === `${web}/api/v3` && auth.issuer === `${web}/login/oauth` &&
    auth.authorizationEndpoint === `${web}/login/oauth/authorize` && auth.tokenEndpoint === `${web}/login/oauth/access_token`;
}

function authorization(headers: Record<string, string>): string | undefined {
  return Object.entries(headers).find(([name]) => name.toLowerCase() === "authorization")?.[1];
}

/** Resolve the current Agent's bound MCP credential at every GitHub dispatch, never a Plugin token. */
export function createAgentGitHubCredentials(deps: GitHubCredentialDeps) {
  async function bindingFor(agent: Agent) {
    const servers = await Promise.all((agent.configuration?.mcpList ?? []).map(binding => deps.mcps.get(binding.name)));
    const github = servers.filter(server => server && (server.auth
      ? mcpAccountProvider(server.auth) === "github" || githubAuthority(server.auth, deps.target)
      : server.name === "github" || new URL(server.url).origin === "https://api.githubcopilot.com"));
    if (github.length > 1) throw new ValidationError("Bind exactly one GitHub MCP server to this Agent for Workspace Git operations");
    return github[0];
  }
  return {
    /** Listing does not decrypt credentials or refresh OAuth grants. Dispatch rechecks authentication. */
    async configured(agent: Agent): Promise<boolean> {
      const auth = (await bindingFor(agent))?.auth;
      return !!auth && githubAuthority(auth, deps.target);
    },
    async token(agentName: string, user: RunUser): Promise<string> {
      const agent = await deps.authorize(agentName, user);
      const server = await bindingFor(agent);
      if (!server) throw new ValidationError("Connect a GitHub MCP server in this Agent's tools before using Workspace Git operations");
      if (!server.auth) throw new ValidationError("Workspace Git operations require your personal GitHub MCP OAuth connection");
      if (!githubAuthority(server.auth, deps.target)) throw new ValidationError("GitHub MCP authorization does not match the Workspace GitHub API endpoint");
      const resolved = await deps.auth.headersFor(user.userId, server.name, server.auth);
      if (resolved.unavailable) throw new ValidationError(resolved.unavailable);
      const value = authorization(resolved.headers);
      const token = /^(?:Bearer|token) ([^\s]+)$/i.exec(value ?? "")?.[1];
      if (!token) throw new ValidationError("Your GitHub MCP connection requires a valid GitHub Authorization credential for Workspace Git operations");
      return token;
    },
  };
}
