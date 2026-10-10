import type { MemberRepository } from "@/domain/member/repository";
import type { Member } from "@/domain/member/types";
import type { UsageRepository } from "@/domain/usage/repository";
import type { MemberUsageRow } from "@/domain/usage/types";
import { mergeUsageCounters } from "@/domain/usage/counters";
import { listMembers } from "@/application/member/memberUseCases";
import { mapWithLimit } from "@/shared/mapWithLimit";

/** Concurrent indexed member reads; never one unbounded burst per account. */
const MEMBER_USAGE_CONCURRENCY = 8;

export interface MemberUsageSummary {
  members: Array<Pick<Member, "id" | "name" | "email">>;
  items: Array<Omit<MemberUsageRow, "agentName">>;
}

/** Admin-only at the HTTP boundary. Personal ledgers retain spend after Agent deletion. */
export async function summarizeMemberUsage(
  usage: UsageRepository, members: MemberRepository, from: string, to: string,
): Promise<MemberUsageSummary> {
  const accounts = await listMembers(members);
  const pages = await mapWithLimit(accounts, MEMBER_USAGE_CONCURRENCY, async member => {
    const daily = new Map<string, Omit<MemberUsageRow, "agentName">>();
    for (const row of await usage.listMemberDays(member.id, from, to)) {
      daily.set(row.date, { ...mergeUsageCounters(daily.get(row.date), row), userId: member.id, date: row.date });
    }
    return [...daily.values()];
  });
  return { members: accounts.map(({ id, name, email }) => ({ id, name, email })), items: pages.flat() };
}
