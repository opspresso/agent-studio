import type { AgentRepository } from "@/domain/agent/repository";
import type { UsageRepository } from "@/domain/usage/repository";
import type { MemberUsageRow, UsageRow } from "@/domain/usage/types";
import { assertAgentOwnerOrAdminReadable } from "@/application/agent/agentUseCases";
import { memberMonthToDate } from "./memberCostGuard";
import { listAgentActors, type ListActorsDeps, type AgentActorUsage } from "./listActors";

/**
 * Usage rows over a date range — the dashboard read. One agent's rows when a
 * agent is named, every agent's otherwise. The totals are open to any
 * signed-in user because the agent catalog is shared; the per-caller
 * breakdown below is not, which is why the two reads authorize differently.
 */
export function listUsageSummary(
  usage: UsageRepository,
  from: string,
  to: string,
  agentName?: string,
): Promise<UsageRow[]> {
  return agentName
    ? usage.listByAgent(agentName, from, to)
    : usage.listByDateRange(from, to);
}

export interface UsageReadDeps extends ListActorsDeps {
  agents: AgentRepository;
}

/**
 * One member's own daily spend over a range — the profile read, and the same
 * rows in the same shape the agent usage page gets for an agent. Always the
 * caller's own email (the route passes the session user), which is why this
 * needs no gate: `memberCostGuard` owns enforcing the cap, this only reports
 * the rows it counts.
 */
export function listMemberUsage(
  usage: UsageRepository,
  email: string,
  from: string,
  to: string,
): Promise<MemberUsageRow[]> {
  return usage.listMemberDays(email, from, to);
}

/**
 * Who spent an agent's budget, owner/admin only: a breakdown by caller names
 * individuals and what they ran, so it is gated like traces rather than like
 * the shared totals.
 */
export async function listAgentActorsFor(
  deps: UsageReadDeps,
  agentName: string,
  userEmail: string,
  from: string,
  to: string,
): Promise<AgentActorUsage> {
  const agent = await assertAgentOwnerOrAdminReadable(deps.agents, agentName, userEmail);
  return listAgentActors(deps, agent, from, to);
}

/**
 * The slice bound to its repositories, cipher and Slack lookup, composed once
 * so the presentation layer chooses neither cipher nor profile client.
 */
export interface UsageUseCases {
  summary(from: string, to: string, agentName?: string): Promise<UsageRow[]>;
  actors(
    agentName: string,
    userEmail: string,
    from: string,
    to: string,
  ): Promise<AgentActorUsage>;
  memberUsage(email: string, from: string, to: string): Promise<MemberUsageRow[]>;
  /** This member's spend since the first of the UTC month — what the cap bounds. */
  memberMonthToDate(email: string, now?: Date): Promise<number>;
}

export function createUsageUseCases(deps: UsageReadDeps): UsageUseCases {
  return {
    summary: (from, to, agentName) => listUsageSummary(deps.usage, from, to, agentName),
    actors: (agentName, userEmail, from, to) =>
      listAgentActorsFor(deps, agentName, userEmail, from, to),
    memberUsage: (email, from, to) => listMemberUsage(deps.usage, email, from, to),
    memberMonthToDate: (email, now) => memberMonthToDate(deps, email, now),
  };
}
