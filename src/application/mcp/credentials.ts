import type { McpBinding } from "@/domain/agent/types";
import type { McpServer } from "@/domain/mcp/types";
import type { McpAuthProvider } from "@/domain/mcp/oauth";
import type { SecretCipher } from "@/domain/security/secretCipher";
import { agentMcpHeadersContext, mcpHeadersContext } from "@/domain/security/secretContext";
import { hasMcpHeaderSecrets, mcpHeaderTarget } from "@/application/mcpHeaderTarget";
import { stripMcpMetadataHeaders } from "@/application/mcpMetadataHeaders";

export interface McpCredentials {
  headers: Record<string, string>;
  credentialFingerprint?: string;
  warning?: string;
  unavailable?: string;
}

/** One credential policy for Agent execution, owner probes and native GitHub operations. */
export async function resolveMcpCredentials(
  deps: { cipher: SecretCipher; auth: McpAuthProvider },
  agentName: string,
  server: McpServer,
  binding?: Pick<McpBinding, "headers" | "headerTarget">,
): Promise<McpCredentials> {
  let overrides = binding?.headers;
  let warning: string | undefined;
  let credentialFingerprint: string | undefined;
  if (hasMcpHeaderSecrets(overrides) && binding?.headerTarget !== mcpHeaderTarget(server.url)) {
    overrides = Object.fromEntries(Object.entries(overrides ?? {}).filter(([, value]) => value === null));
    warning = `MCP server '${server.name}' moved since its Agent header credentials were saved; ` +
      "those credentials were not sent. Re-enter them for the current endpoint.";
  }
  const headers = deps.cipher.mergeOutboundHeaders(server.headers, overrides,
    mcpHeadersContext(server.name), agentMcpHeadersContext(agentName, server.name));
  stripMcpMetadataHeaders(headers);
  if (server.auth) {
    const resolved = await deps.auth.headersFor(agentName, server.name, server.auth);
    if (resolved.unavailable) {
      if (Object.keys(headers).length === 0) return { headers, warning, unavailable: resolved.unavailable };
    } else {
      credentialFingerprint = resolved.credentialFingerprint;
      // Fetch folds duplicate case variants into a comma-joined credential. Replace every spelling.
      for (const [name, value] of Object.entries(resolved.headers)) {
        for (const existing of Object.keys(headers)) if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing];
        headers[name] = value;
      }
    }
  }
  return { headers, warning, credentialFingerprint };
}
