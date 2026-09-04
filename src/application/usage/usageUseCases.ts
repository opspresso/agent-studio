import type { ProjectRepository } from "@/domain/project/repository";
import type { UsageRepository } from "@/domain/usage/repository";
import type { MemberUsageRow, UsageRow } from "@/domain/usage/types";
import { assertProjectWritable } from "@/application/project/projectUseCases";
import { memberMonthToDate } from "./memberCostGuard";
import { listProjectActors, type ActorUsageView, type ListActorsDeps } from "./listActors";

/**
 * Usage rows over a date range — the dashboard read. One project's rows when a
 * project is named, every project's otherwise. The totals are open to any
 * signed-in user because the project catalog is shared; the per-caller
 * breakdown below is not, which is why the two reads authorize differently.
 */
export function listUsageSummary(
  usage: UsageRepository,
  from: string,
  to: string,
  projectName?: string,
): Promise<UsageRow[]> {
  return projectName
    ? usage.listByProject(projectName, from, to)
    : usage.listByDateRange(from, to);
}

export interface UsageReadDeps extends ListActorsDeps {
  projects: ProjectRepository;
}

/**
 * One member's own daily spend over a range — the profile read, and the same
 * rows in the same shape the project usage page gets for a project. Always the
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
 * Who spent a project's budget, owner/admin only: a breakdown by caller names
 * individuals and what they ran, so it is gated like traces rather than like
 * the shared totals.
 */
export async function listProjectActorsFor(
  deps: UsageReadDeps,
  projectName: string,
  userEmail: string,
  from: string,
  to: string,
): Promise<ActorUsageView[]> {
  const project = await assertProjectWritable(deps.projects, projectName, userEmail);
  return listProjectActors(deps, project, from, to);
}

/**
 * The slice bound to its repositories, cipher and Slack lookup, composed once
 * so the presentation layer chooses neither cipher nor profile client.
 */
export interface UsageUseCases {
  summary(from: string, to: string, projectName?: string): Promise<UsageRow[]>;
  actors(projectName: string, userEmail: string, from: string, to: string): Promise<ActorUsageView[]>;
  memberUsage(email: string, from: string, to: string): Promise<MemberUsageRow[]>;
  /** This member's spend since the first of the UTC month — what the cap bounds. */
  memberMonthToDate(email: string, now?: Date): Promise<number>;
}

export function createUsageUseCases(deps: UsageReadDeps): UsageUseCases {
  return {
    summary: (from, to, projectName) => listUsageSummary(deps.usage, from, to, projectName),
    actors: (projectName, userEmail, from, to) =>
      listProjectActorsFor(deps, projectName, userEmail, from, to),
    memberUsage: (email, from, to) => listMemberUsage(deps.usage, email, from, to),
    memberMonthToDate: (email, now) => memberMonthToDate(deps, email, now),
  };
}
