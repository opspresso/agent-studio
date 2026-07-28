import type { ProjectRepository } from "@/domain/project/repository";
import type { Project, ProjectType } from "@/domain/project/types";
import { ConflictError, ForbiddenError, NotFoundError, isConditionalWriteFailure } from "@/application/errors";
import { isConfiguredAdmin } from "@/lib/runtime-settings";
import { nextUpdatedAt } from "./timestamps";

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
 * Load a project and assert `userEmail` may mutate it. Projects are a shared
 * catalog — any signed-in user may read and run them; writing is for the owner
 * and for admins. Mutation use cases call this before writing.
 *
 * The admin case is checked here rather than threaded through the twenty-odd
 * call sites as a flag: the rule is "owner or admin", and a flag that any one
 * of those callers forgot to pass would silently narrow it back to owner-only
 * for that path alone. `isConfiguredAdmin` reads the effective admin list, so
 * demoting an admin on the settings page takes effect without a redeploy — and
 * it is the *configured* check, so a deployment with no admin list keeps plain
 * owner-only mutation rather than opening every project to everyone.
 */
export async function assertProjectOwner(
  repo: ProjectRepository,
  name: string,
  userEmail: string,
): Promise<Project> {
  const project = await getProject(repo, name);
  if (project.ownerEmail === userEmail) {
    return project;
  }
  if (await isConfiguredAdmin(userEmail)) {
    return project;
  }
  throw new ForbiddenError(`You do not have permission to modify project "${name}"`);
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
  const existing = await assertProjectOwner(repo, name, userEmail);
  const updated: Project = {
    ...existing,
    displayName: input.displayName ?? existing.displayName,
    description: input.description ?? existing.description,
    departmentCode: input.departmentCode ?? existing.departmentCode,
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
  await assertProjectOwner(repo, name, userEmail);
  await repo.delete(name);
}
