import type { ProjectRepository } from "@/domain/project/repository";
import type { CostLimits, Project, ProjectType } from "@/domain/project/types";
import { ConflictError, ForbiddenError, NotFoundError, isConditionalWriteFailure } from "@/application/errors";
import { isConfiguredAdmin } from "@/lib/runtime-settings";
import { nextUpdatedAt } from "./timestamps";
import { log } from "@/shared/logger";

export interface CreateProjectInput {
  name: string;
  displayName: string;
  description: string;
  projectType: ProjectType;
  ownerEmail: string;
  departmentCode?: string;
}

export interface UpdateProjectInput {
  displayName?: string;
  description?: string;
  departmentCode?: string;
  /** Replaces the stored guards; `null` removes them. Absent leaves them alone. */
  costLimits?: CostLimits | null;
}

export function listProjects(repo: ProjectRepository): Promise<Project[]> {
  return repo.list();
}

export async function getProject(repo: ProjectRepository, name: string): Promise<Project> {
  const project = await repo.get(name);
  if (!project) {
    throw new NotFoundError(`Project "${name}" not found`);
  }
  return project;
}

/**
 * Load a project and assert `userEmail` may write it. Projects are a shared
 * catalog — any signed-in user may read and run them; writing is for the owner
 * and for admins.
 *
 * Named for what it checks, not for the owner alone: it is bound at twenty-odd
 * call sites, and while it asserted ownership the name was the documentation.
 * Anything that ever needs *ownership* specifically — attributing a quota,
 * choosing whose credentials to dispatch with, deciding whom to notify — must
 * read `project.ownerEmail` and not reach for this.
 *
 * The admin case is checked here rather than threaded through those call sites
 * as a flag: the rule is "owner or admin", and a flag any one caller forgot to
 * pass would silently narrow it back to owner-only for that path alone.
 * `isConfiguredAdmin` reads the effective admin list, so demoting an admin on
 * the settings page takes effect without a redeploy — and it is the *configured*
 * check, so a deployment with no admin list keeps plain owner-only writes rather
 * than opening every project to everyone.
 */
export async function assertProjectWritable(
  repo: ProjectRepository,
  name: string,
  userEmail: string,
): Promise<Project> {
  const project = await getProject(repo, name);
  if (project.ownerEmail === userEmail) {
    return project;
  }
  if (await isAdminOverride(userEmail)) {
    // The owner cannot see this happen from the data — a deleted project takes
    // the row that would have named who deleted it — so the override is the
    // thing worth recording, not the eventual write.
    log.warn(
      "authz",
      `admin ${userEmail} is acting on project "${name}" owned by ${project.ownerEmail}`,
    );
    return project;
  }
  throw new ForbiddenError(`You do not have permission to modify project "${name}"`);
}

/**
 * The admin override, resolved so that losing the settings store denies rather
 * than throws.
 *
 * Only a non-owner reaches this, and for a non-owner on a deployment with no
 * admin list the answer is "no" without any I/O at all. Letting a settings read
 * failure escape would turn the deterministic 403 that path has always returned
 * into a 500, so an outage would change *which* error an unauthorized caller
 * sees. Failing closed keeps the denial.
 */
async function isAdminOverride(userEmail: string): Promise<boolean> {
  try {
    return await isConfiguredAdmin(userEmail);
  } catch (error) {
    log.error("authz", "admin list unavailable; denying the override", error);
    return false;
  }
}

export async function createProject(
  repo: ProjectRepository,
  input: CreateProjectInput,
): Promise<Project> {
  const existing = await repo.get(input.name);
  if (existing) {
    throw new ConflictError(`Project "${input.name}" already exists`);
  }

  const now = new Date().toISOString();
  const project: Project = {
    name: input.name,
    displayName: input.displayName,
    description: input.description,
    projectType: input.projectType,
    ownerEmail: input.ownerEmail,
    departmentCode: input.departmentCode,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await repo.create(project);
  } catch (error) {
    // The repository's conditional put loses a create race the pre-check missed.
    if (isConditionalWriteFailure(error)) {
      throw new ConflictError(`Project "${input.name}" already exists`);
    }
    throw error;
  }
  return project;
}

export async function updateProject(
  repo: ProjectRepository,
  name: string,
  input: UpdateProjectInput,
  userEmail: string,
): Promise<Project> {
  const existing = await assertProjectWritable(repo, name, userEmail);
  const updated: Project = {
    ...existing,
    displayName: input.displayName ?? existing.displayName,
    description: input.description ?? existing.description,
    departmentCode: input.departmentCode ?? existing.departmentCode,
    // Three-state on purpose: absent keeps, `null` clears, an object replaces.
    // `??` alone cannot express the clear, and a spread merge could not remove
    // one threshold while keeping the other.
    ...(input.costLimits === undefined
      ? {}
      : input.costLimits === null
        ? { costLimits: undefined }
        : { costLimits: input.costLimits }),
    updatedAt: nextUpdatedAt(existing.updatedAt),
  };
  try {
    await repo.update(updated, existing.updatedAt);
  } catch (error) {
    if (isConditionalWriteFailure(error)) {
      throw new ConflictError(`Project "${name}" was modified by another request`);
    }
    throw error;
  }
  return updated;
}

/** Delete a project. The repository cascades version and usage cleanup. */
export async function deleteProject(
  repo: ProjectRepository,
  name: string,
  userEmail: string,
): Promise<void> {
  await assertProjectWritable(repo, name, userEmail);
  await repo.delete(name);
}
