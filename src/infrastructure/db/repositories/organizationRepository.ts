/**
 * The tenant registry.
 *
 * These rows sit outside every tenant's scope, because they are what says the
 * scopes exist — reading the list of tenants from inside one would be circular.
 * They carry no TTL: a tenant record is not an operational log.
 */

import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { getDocumentClient, getTableName } from "@/infrastructure/db/client";
import { queryAll } from "@/infrastructure/db/query";
import { keys } from "@/infrastructure/db/keys";
import type { OrganizationRepository } from "@/domain/organization/repository";
import type { Organization } from "@/domain/organization/types";

const ENTITY = "Organization";

function toOrganization(item: Record<string, unknown>): Organization {
  return {
    id: String(item.id ?? ""),
    displayName: String(item.displayName ?? ""),
    createdAt: String(item.createdAt ?? ""),
    updatedAt: String(item.updatedAt ?? ""),
  };
}

function toItem(organization: Organization): Record<string, unknown> {
  return {
    ...keys.organization(organization.id),
    ...organization,
    entityType: ENTITY,
    GSI1PK: keys.organizationPartition(),
    GSI1SK: organization.id,
  };
}

export const organizationRepository: OrganizationRepository = {
  async get(id) {
    const result = await getDocumentClient().send(
      new GetCommand({ TableName: getTableName(), Key: keys.organization(id) }),
    );
    return result.Item ? toOrganization(result.Item) : null;
  },

  async list() {
    const items = await queryAll({
      TableName: getTableName(),
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: { ":pk": keys.organizationPartition() },
    });
    return items.map(toOrganization);
  },

  async create(organization) {
    await getDocumentClient().send(
      new PutCommand({
        TableName: getTableName(),
        Item: toItem(organization),
        // The id is a key prefix: a lost race here would merge two tenants'
        // rows into one namespace, which no later check could untangle.
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
  },

  async update(organization) {
    await getDocumentClient().send(
      new PutCommand({ TableName: getTableName(), Item: toItem(organization) }),
    );
  },

  async delete(id) {
    await getDocumentClient().send(
      new DeleteCommand({ TableName: getTableName(), Key: keys.organization(id) }),
    );
  },
};
