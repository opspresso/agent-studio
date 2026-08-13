import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { MemberRepository } from "@/domain/member/repository";
import { toMemberTier } from "@/domain/member/tiers";
import type { Member } from "@/domain/member/types";
import { getDocumentClient, getTableName } from "@/infrastructure/db/client";
import { keys } from "@/infrastructure/db/keys";
import { queryAll } from "@/infrastructure/db/query";

function iso(value: unknown): string | null {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toMember(item: Record<string, unknown>): Member | null {
  const joinedAt = iso(item.createdAt);
  if (
    typeof item.id !== "string" ||
    typeof item.name !== "string" ||
    typeof item.email !== "string" ||
    !joinedAt
  ) {
    return null;
  }
  return {
    id: item.id,
    name: item.name,
    email: item.email,
    image: typeof item.image === "string" ? item.image : null,
    tier: toMemberTier(item.tier),
    joinedAt,
    lastLoginAt: iso(item.lastLoginAt),
  };
}

export const memberRepository: MemberRepository = {
  async list() {
    const items = await queryAll({
      TableName: getTableName(),
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: { ":pk": keys.authModelPartition("user") },
    });
    return items.flatMap((item): Member[] => {
      const member = toMember(item);
      return member ? [member] : [];
    });
  },

  async getByEmail(email) {
    // The user row itself carries the unique-lookup GSI2 attributes (see
    // `buildItem` in the auth adapter), so this is one query — no lock-row hop.
    const items = await queryAll({
      TableName: getTableName(),
      IndexName: "GSI2",
      KeyConditionExpression: "GSI2PK = :pk",
      ExpressionAttributeValues: { ":pk": keys.authUniqueLookup("user", "email", email) },
    });
    for (const item of items) {
      const member = toMember(item);
      if (member) {
        return member;
      }
    }
    return null;
  },

  async setTier(id, tier) {
    // Atomic on the one attribute on purpose: the auth adapter's `update` is
    // read-modify-replace of the *whole item*, and routing a tier write through
    // it would let a concurrent `lastLoginAt` write revert the tier wholesale.
    // The converse race — the adapter's replace overwriting a tier committed
    // inside its read window — remains, but is bounded to that user's own
    // sign-in and a milliseconds-wide window.
    let attributes: Record<string, unknown>;
    try {
      const result = await getDocumentClient().send(
        new UpdateCommand({
          TableName: getTableName(),
          Key: keys.auth("user", id),
          ConditionExpression: "attribute_exists(PK)",
          UpdateExpression: "SET tier = :tier",
          ExpressionAttributeValues: { ":tier": tier },
          ReturnValues: "ALL_OLD",
        }),
      );
      attributes = result.Attributes ?? {};
    } catch (error) {
      if ((error as { name?: string }).name === "ConditionalCheckFailedException") {
        return null;
      }
      throw error;
    }
    const before = toMember(attributes);
    if (!before) {
      return null;
    }
    return { member: { ...before, tier }, previousTier: before.tier };
  },
};
