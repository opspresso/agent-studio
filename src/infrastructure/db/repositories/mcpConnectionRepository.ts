import { CONDITIONAL_WRITE_FAILED, deleteItem, getItem, putItem, queryItems, updateItem } from "../store";
import { keys } from "../keys";
import type { McpConnection, McpConnectionRepository } from "@/domain/mcp/connection";
import type { TokenEndpointAuthMethod } from "@/domain/mcp/types";

const ENTITY_TYPE = "MCPCONNECTION";

/**
 * The domain's ISO `expiresAt` is parked under this name: the `expiresAt`
 * attribute is the store's unix-seconds TTL, and a connection must outlive
 * its token — a numeric write under that name would enrol the row in the
 * sweep. Legacy rows still carry the string under `expiresAt`; reads fall
 * back to it and every write clears it.
 */
const EXPIRES_AT_ISO = "expiresAtIso";

function toItem(connection: McpConnection): Record<string, unknown> {
  const { expiresAt, ...rest } = connection;
  return {
    ...keys.mcpConnection(connection.projectName, connection.serverName),
    entityType: ENTITY_TYPE,
    ...rest,
    ...(expiresAt === undefined ? {} : { [EXPIRES_AT_ISO]: expiresAt }),
  };
}

/** A stored `null` reads back as `null`, which the optional fields' type denies. */
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isAuthMethod(value: unknown): value is TokenEndpointAuthMethod {
  return value === "client_secret_basic" || value === "client_secret_post" || value === "none";
}

/**
 * A stored row as a connection, or `null` for one this code cannot use.
 *
 * `issuer` and `resource` are what a stored token is checked against before it
 * is sent anywhere — the two axes that stop one server's credentials reaching
 * another. A row written before they were recorded has neither, and there is no
 * safe value to invent: the old fallback ("assume it belongs to whatever the
 * entry points at now") is the assumption those fields exist to stop making.
 * Read as absent instead, so the console offers a reconnect, which is the only
 * thing that can supply the missing halves.
 */
function fromItem(item: Record<string, unknown>): McpConnection | null {
  const issuer = optionalString(item.issuer);
  const resource = optionalString(item.resource);
  if (!issuer || !resource) {
    return null;
  }
  return {
    projectName: item.projectName as string,
    serverName: item.serverName as string,
    clientId: item.clientId as string,
    clientSecret: optionalString(item.clientSecret),
    // Read back explicitly, unlike the write, which spreads the whole
    // connection: a field added to the type and not to this list is stored and
    // then silently lost. Both of these decide whether the issuer check applies
    // to the row — the first exempts a client this deployment hosts, the second
    // one the app can re-register on the owner's behalf — so losing either turns
    // a recoverable connection into one that refuses to reconnect.
    ...(item.clientFromMetadataDocument === true ? { clientFromMetadataDocument: true } : {}),
    ...(item.clientRegistered === true ? { clientRegistered: true } : {}),
    // The method the registration recorded, which the token endpoint enforces;
    // lost on the way back, every exchange falls to the entry's discovered one.
    ...(isAuthMethod(item.tokenEndpointAuthMethod) ? { tokenEndpointAuthMethod: item.tokenEndpointAuthMethod } : {}),
    issuer,
    resource,
    scopes: (item.scopes as string[] | undefined) ?? [],
    accessToken: optionalString(item.accessToken),
    refreshToken: optionalString(item.refreshToken),
    expiresAt: optionalString(item[EXPIRES_AT_ISO] ?? item.expiresAt),
    status: item.status as McpConnection["status"],
    connectedBy: optionalString(item.connectedBy),
    connectedAt: optionalString(item.connectedAt),
    updatedAt: item.updatedAt as string,
  };
}

export const mcpConnectionRepository: McpConnectionRepository = {
  async get(projectName, serverName) {
    const item = await getItem(keys.mcpConnection(projectName, serverName));
    return item ? fromItem(item) : null;
  },

  async listByProject(projectName) {
    const items = await queryItems({
      pk: keys.projectPartition(projectName),
      sk: { prefix: keys.mcpConnectionPrefix() },
    });
    return items.map(fromItem).filter((connection) => connection !== null);
  },

  async put(connection) {
    await putItem(toItem(connection));
  },

  /**
   * Compare-and-set on the refresh token. An absent expectation covers both a
   * connection that never had one and the first write after authorization, so
   * a caller that refreshed from "no refresh token" still cannot clobber a
   * token another instance has since stored.
   */
  async updateTokens(projectName, serverName, expectedRefreshToken, next) {
    try {
      await updateItem(
        keys.mcpConnection(projectName, serverName),
        (row) => {
          // Absent values are removed, never written as null: the presence of
          // `refreshToken` is the condition that decides a race, and a stored
          // NULL would read as present while carrying no token. The legacy
          // `expiresAt` string goes too — it would shadow a removed
          // `expiresAtIso` through the read fallback.
          const {
            accessToken: _a,
            refreshToken: _r,
            [EXPIRES_AT_ISO]: _e,
            expiresAt: _legacy,
            ...rest
          } = row ?? {};
          void _a, _r, _e, _legacy;
          return {
            ...rest,
            status: next.status,
            updatedAt: next.updatedAt,
            // Widened by a scope challenge, under the same condition as the
            // tokens: an unconditional put here clobbered a reconnect that
            // landed between the read and the write.
            ...(next.scopes !== undefined ? { scopes: next.scopes } : {}),
            ...(next.accessToken !== undefined ? { accessToken: next.accessToken } : {}),
            ...(next.refreshToken !== undefined ? { refreshToken: next.refreshToken } : {}),
            ...(next.expiresAt !== undefined ? { [EXPIRES_AT_ISO]: next.expiresAt } : {}),
          };
        },
        // The row must still exist: a connection deleted mid-refresh must not
        // be resurrected by the refresh that was already in flight.
        (row) =>
          row !== null &&
          (expectedRefreshToken === undefined
            ? row.refreshToken === undefined
            : row.refreshToken === expectedRefreshToken),
      );
      return true;
    } catch (error) {
      if ((error as { name?: string }).name === CONDITIONAL_WRITE_FAILED) {
        return false;
      }
      throw error;
    }
  },

  async delete(projectName, serverName) {
    await deleteItem(keys.mcpConnection(projectName, serverName));
  },
};
