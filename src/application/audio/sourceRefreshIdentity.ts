import { createHash } from "node:crypto";
import type { McpConnection } from "@/domain/mcp/connection";
import type { McpServer } from "@/domain/mcp/types";
import type { McpBinding } from "@/domain/project/types";

/** Reauthorization changes identity; ordinary token rotation does not. */
export function sourceRefreshFingerprint(server: McpServer, binding: McpBinding,
  connection: Pick<McpConnection, "connectedAt" | "connectedBy" | "clientId" | "issuer" | "resource" | "status" | "authorizationEpoch"> | null) {
  return createHash("sha256").update(JSON.stringify({ url: server.url, auth: server.auth, headers: server.headers, binding,
    connection: server.auth ? { authorizationEpoch: connection?.authorizationEpoch, connectedAt: connection?.connectedAt, connectedBy: connection?.connectedBy,
      clientId: connection?.clientId, issuer: connection?.issuer, resource: connection?.resource, status: connection?.status } : undefined,
  })).digest("hex");
}
