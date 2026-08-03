/**
 * Who belongs to which tenant.
 *
 * These rows sit in the organization's partition and outside every tenant's key
 * scope, because they are what *decides* the scope: reading a membership from
 * inside a tenant would require already knowing which tenant to read from.
 *
 * `listByUser` runs on every authenticated request, so it is a GSI1 lookup
 * rather than a scan.
 */

import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { getDocumentClient, getTableName } from "@/infrastructure/db/client";
import { queryAll } from "@/infrastructure/db/query";
import { keys } from "@/infrastructure/db/keys";
import type { MembershipRepository } from "@/domain/organization/repository";
import type { Membership } from "@/domain/organization/membership";
import { isRole } from "@/domain/organization/membership";

const ENTITY = "Membership";

function toMembership(item: Record<string, unknown>): Membership {
  const role = String(item.role ?? "");
  return {
    organizationId: String(item.organizationId ?? ""),
    userEmail: String(item.userEmail ?? ""),
    // An unreadable role is the least capable one, not a crash and not an
    // admin: a row this app cannot interpret must never widen access.
    role: isRole(role) ? role : "viewer",
    createdAt: String(item.createdAt ?? ""),
    updatedAt: String(item.updatedAt ?? ""),
  };
}

function toItem(membership: Membership): Record<string, unknown> {
  return {
    ...keys.membership(membership.organizationId, membership.userEmail),
    ...membership,
    entityType: ENTITY,
    GSI1PK: keys.membershipUserPartition(membership.userEmail),
    GSI1SK: membership.organizationId,
  };
}

export const membershipRepository: MembershipRepository = {
  async get(organizationId, userEmail) {
    const result = await getDocumentClient().send(
      new GetCommand({
        TableName: getTableName(),
        Key: keys.membership(organizationId, userEmail),
      }),
    );
    return result.Item ? toMembership(result.Item) : null;
  },

  async listByOrganization(organizationId) {
    const items = await queryAll({
      TableName: getTableName(),
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: {
        ":pk": keys.organization(organizationId).PK,
        ":prefix": keys.membershipPrefix(),
      },
    });
    return items.map(toMembership);
  },

  async listByUser(userEmail) {
    const items = await queryAll({
      TableName: getTableName(),
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: { ":pk": keys.membershipUserPartition(userEmail) },
    });
    return items.map(toMembership);
  },

  async put(membership) {
    await getDocumentClient().send(
      new PutCommand({ TableName: getTableName(), Item: toItem(membership) }),
    );
  },

  async delete(organizationId, userEmail) {
    await getDocumentClient().send(
      new DeleteCommand({
        TableName: getTableName(),
        Key: keys.membership(organizationId, userEmail),
      }),
    );
  },
};
