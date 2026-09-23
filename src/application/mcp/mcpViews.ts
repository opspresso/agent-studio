import type { McpServer, McpServerAuth } from "@/domain/mcp/types";
import type { SecretCipher } from "@/domain/security/secretCipher";
import { managedMcpEnvironmentContext, mcpHeadersContext, mcpOAuthClientSecretContext } from "@/domain/security/secretContext";
import { urlWithoutUserinfoQueryOrFragment } from "@/shared/url";

export function maskedMcpAuth(cipher: SecretCipher, name: string, auth: McpServerAuth): McpServerAuth {
  return {
    ...auth,
    ...(auth.clientSecret
      ? { clientSecret: cipher.mask(auth.clientSecret, mcpOAuthClientSecretContext(name)) }
      : {}),
  };
}

/** Shared by remote and managed registry writes and reads. */
export function maskedMcpServer(cipher: SecretCipher, server: McpServer): McpServer {
  return {
    ...server,
    url: urlWithoutUserinfoQueryOrFragment(server.url),
    headers: cipher.maskHeaders(server.headers, mcpHeadersContext(server.name)),
    ...(server.environment
      ? { environment: cipher.maskHeaders(server.environment, managedMcpEnvironmentContext(server.name)) }
      : {}),
    ...(server.auth ? { auth: maskedMcpAuth(cipher, server.name, server.auth) } : {}),
  };
}
