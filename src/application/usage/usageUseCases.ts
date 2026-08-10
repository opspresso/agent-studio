import type { ProjectRepository } from "@/domain/project/repository";
import type { UsageRepository } from "@/domain/usage/repository";
import type { UsageRow } from "@/domain/usage/types";
import { assertProjectWritable } from "@/application/project/projectUseCases";
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
 * by the composition root. The actors route used to assemble this bundle per
 * request — the presentation layer choosing which cipher decrypts a bot token
 * and which client resolves a profile.
 */
export interface UsageUseCases {
  summary(from: string, to: string, projectName?: string): Promise<UsageRow[]>;
  actors(projectName: string, userEmail: string, from: string, to: string): Promise<ActorUsageView[]>;
}

export function createUsageUseCases(deps: UsageReadDeps): UsageUseCases {
  return {
    summary: (from, to, projectName) => listUsageSummary(deps.usage, from, to, projectName),
    actors: (projectName, userEmail, from, to) =>
      listProjectActorsFor(deps, projectName, userEmail, from, to),
  };
}
