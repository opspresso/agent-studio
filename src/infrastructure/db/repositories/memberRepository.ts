import type { MemberRepository } from "@/domain/member/repository";
import type { Member } from "@/domain/member/types";
import { getTableName } from "@/infrastructure/db/client";
import { keys } from "@/infrastructure/db/keys";
import { queryAll } from "@/infrastructure/db/query";

function iso(value: unknown): string | null {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
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
      const joinedAt = iso(item.createdAt);
      if (
        typeof item.id !== "string" ||
        typeof item.name !== "string" ||
        typeof item.email !== "string" ||
        !joinedAt
      ) {
        return [];
      }
      return [{
        id: item.id,
        name: item.name,
        email: item.email,
        image: typeof item.image === "string" ? item.image : null,
        joinedAt,
        lastLoginAt: iso(item.lastLoginAt),
      }];
    });
  },
};
