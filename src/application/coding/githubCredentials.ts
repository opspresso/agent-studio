import type { Agent } from "@/domain/agent/types";
import type { AgentRepository } from "@/domain/agent/repository";
import type { McpRepository } from "@/domain/mcp/repository";
import type { McpAuthProvider } from "@/domain/mcp/oauth";
import type { McpServerAuth } from "@/domain/mcp/types";
import { mcpAccountProvider } from "@/domain/mcp/account";
import type { SecretCipher } from "@/domain/security/secretCipher";
import { agentMcpHeadersContext, mcpHeadersContext } from "@/domain/security/secretContext";
import { hasMcpHeaderSecrets, mcpHeaderTarget } from "@/application/mcpHeaderTarget";
import { NotFoundError, ValidationError } from "@/application/errors";

interface GitHubCredentialDeps {
  agents: Pick<AgentRepository, "get">;
  mcps: Pick<McpRepository, "get">;
  auth: McpAuthProvider;
  cipher: SecretCipher;
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
    const bindings = await Promise.all((agent.configuration?.mcpList ?? []).map(async binding => ({ binding, server: await deps.mcps.get(binding.name) })));
    const github = bindings.filter(({ server }) => server && (server.auth
      ? mcpAccountProvider(server.auth) === "github" || githubAuthority(server.auth, deps.target)
      : server.name === "github" || new URL(server.url).origin === "https://api.githubcopilot.com"));
    if (github.length > 1) throw new ValidationError("Bind exactly one GitHub MCP server to this Agent for Workspace Git operations");
    return github[0];
  }
  return {
    /** Listing does not decrypt credentials or refresh OAuth grants. Dispatch rechecks authentication. */
    async configured(agent: Agent): Promise<boolean> { return !!await bindingFor(agent); },
    async token(agentName: string): Promise<string> {
      const agent = await deps.agents.get(agentName);
      if (!agent) throw new NotFoundError("Agent not found");
      const selected = await bindingFor(agent);
      if (!selected?.server) throw new ValidationError("Connect a GitHub MCP server in this Agent's settings before using Workspace Git operations");
      const { binding, server } = selected;
      let overrides = binding.headers;
      if (hasMcpHeaderSecrets(overrides) && binding.headerTarget !== mcpHeaderTarget(server.url)) {
        // Match MCP dispatch: stale credentials cannot follow a registry entry to a new endpoint.
        overrides = Object.fromEntries(Object.entries(overrides ?? {}).filter(([, value]) => value === null));
      }
      let value = authorization(deps.cipher.mergeOutboundHeaders(server.headers, overrides,
        mcpHeadersContext(server.name), agentMcpHeadersContext(agentName, server.name)));
      if (server.auth) {
        if (!githubAuthority(server.auth, deps.target)) throw new ValidationError("GitHub MCP authorization does not match the Workspace GitHub API endpoint");
        const resolved = await deps.auth.headersFor(agentName, server.name, server.auth);
        if (!resolved.unavailable) value = authorization(resolved.headers);
        else if (!value) throw new ValidationError(resolved.unavailable);
      }
      const token = /^(?:Bearer|token) ([^\s]+)$/i.exec(value ?? "")?.[1];
      if (!token) throw new ValidationError("The Agent's GitHub MCP requires a valid GitHub Authorization credential for Workspace Git operations");
      return token;
    },
  };
}
