import type { McpConnection } from "@/domain/mcp/connection";
import type { TokenRequestTarget } from "@/domain/mcp/oauth";
import type { McpServerAuth } from "@/domain/mcp/types";
import type { SecretCipher } from "@/domain/security/secretCipher";
import { mcpConnectionSecretContext, mcpOAuthClientSecretContext } from "@/domain/security/secretContext";

/** A shared client is referenced, never copied into a project's grant. */
export function registryClientMismatch(connection: McpConnection, auth: McpServerAuth): boolean {
  return connection.clientFromRegistry === true && connection.clientId !== auth.clientId;
}

/** Call only after validating the grant's issuer, resource and client identity. */
export function mcpTokenTarget(
  cipher: SecretCipher,
  connection: McpConnection,
  auth: McpServerAuth,
): TokenRequestTarget {
  const shared = connection.clientFromRegistry === true;
  const stored = shared ? auth.clientSecret : connection.clientSecret;
  return {
    tokenEndpoint: auth.tokenEndpoint,
    clientId: connection.clientId,
    ...(stored ? {
      clientSecret: cipher.decrypt(stored, shared
        ? mcpOAuthClientSecretContext(connection.serverName)
        : mcpConnectionSecretContext(connection.projectName, connection.serverName, "client-secret")),
    } : {}),
    tokenEndpointAuthMethod: shared
      ? auth.tokenEndpointAuthMethod
      : connection.tokenEndpointAuthMethod ?? auth.tokenEndpointAuthMethod,
    resource: auth.resource,
  };
}
