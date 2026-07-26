import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { getDocumentClient, getTableName } from "../client";
import { keys } from "../keys";
import { queryAll } from "../query";
import type { McpConnection, McpConnectionRepository } from "@/domain/mcp/connection";

const ENTITY_TYPE = "MCPCONNECTION";

function toItem(connection: McpConnection): Record<string, unknown> {
  return {
    ...keys.mcpConnection(connection.projectName, connection.serverName),
    entityType: ENTITY_TYPE,
    ...connection,
  };
}

/** A stored `null` reads back as `null`, which the optional fields' type denies. */
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function fromItem(item: Record<string, unknown>): McpConnection {
  return {
    projectName: item.projectName as string,
    serverName: item.serverName as string,
    clientId: item.clientId as string,
    clientSecret: optionalString(item.clientSecret),
    clientRegistered: item.clientRegistered === true,
    scopes: (item.scopes as string[] | undefined) ?? [],
    accessToken: optionalString(item.accessToken),
    refreshToken: optionalString(item.refreshToken),
    expiresAt: optionalString(item.expiresAt),
    status: item.status as McpConnection["status"],
    connectedBy: optionalString(item.connectedBy),
    connectedAt: optionalString(item.connectedAt),
    updatedAt: item.updatedAt as string,
  };
}

export const mcpConnectionRepository: McpConnectionRepository = {
  async get(projectName, serverName) {
    const result = await getDocumentClient().send(
      new GetCommand({
        TableName: getTableName(),
        Key: keys.mcpConnection(projectName, serverName),
      }),
    );
    return result.Item ? fromItem(result.Item) : null;
  },

  async listByProject(projectName) {
    const items = await queryAll({
      TableName: getTableName(),
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: {
        ":pk": keys.projectPartition(projectName),
        ":prefix": keys.mcpConnectionPrefix(),
      },
    });
    return items.map(fromItem);
  },

  async put(connection) {
    await getDocumentClient().send(
      new PutCommand({ TableName: getTableName(), Item: toItem(connection) }),
    );
  },

  /**
   * Compare-and-set on the refresh token. `attribute_not_exists` covers both a
   * connection that never had one and the first write after authorization, so a
   * caller that refreshed from "no refresh token" still cannot clobber a token
   * another instance has since stored.
   */
  async updateTokens(projectName, serverName, expectedRefreshToken, next) {
    const expected =
      expectedRefreshToken === undefined
        ? { condition: "attribute_not_exists(refreshToken)", values: {} }
        : {
            condition: "refreshToken = :expected",
            values: { ":expected": expectedRefreshToken },
          };
    // Absent values are REMOVEd, never written as null: `attribute_not_exists`
    // above is the condition that decides a race, and a stored NULL would
    // satisfy `attribute_exists` while carrying no token.
    const sets = ["#status = :status", "updatedAt = :updatedAt"];
    const removes: string[] = [];
    const values: Record<string, unknown> = {
      ...expected.values,
      ":status": next.status,
      ":updatedAt": next.updatedAt,
    };
    for (const [name, value] of [
      ["accessToken", next.accessToken],
      ["refreshToken", next.refreshToken],
      ["expiresAt", next.expiresAt],
    ] as const) {
      if (value === undefined) {
        removes.push(name);
      } else {
        sets.push(`${name} = :${name}`);
        values[`:${name}`] = value;
      }
    }
    try {
      await getDocumentClient().send(
        new UpdateCommand({
          TableName: getTableName(),
          Key: keys.mcpConnection(projectName, serverName),
          UpdateExpression: `SET ${sets.join(", ")}${removes.length > 0 ? ` REMOVE ${removes.join(", ")}` : ""}`,
          // The row must still exist: a connection deleted mid-refresh must not
          // be resurrected by the refresh that was already in flight.
          ConditionExpression: `attribute_exists(PK) AND (${expected.condition})`,
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: values,
        }),
      );
      return true;
    } catch (error) {
      if ((error as { name?: string }).name === "ConditionalCheckFailedException") {
        return false;
      }
      throw error;
    }
  },

  async delete(projectName, serverName) {
    await getDocumentClient().send(
      new DeleteCommand({
        TableName: getTableName(),
        Key: keys.mcpConnection(projectName, serverName),
      }),
    );
  },
};
