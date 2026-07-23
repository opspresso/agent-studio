import type { ProjectRepository } from "@/domain/project/repository";
import type { Project, ProjectType } from "@/domain/project/types";
import { ConflictError, ForbiddenError, NotFoundError } from "./errors";

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
 * Load a project and assert `userEmail` owns it. Projects are a shared catalog —
 * any signed-in user may read and run them, but only the owner may mutate.
 * Mutation use cases call this before writing.
 */
export async function assertProjectOwner(
  repo: ProjectRepository,
  name: string,
  userEmail: string,
): Promise<Project> {
  const project = await getProject(repo, name);
  if (project.ownerEmail !== userEmail) {
    throw new ForbiddenError(`You do not have permission to modify project "${name}"`);
  }
  return project;
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
    if (error instanceof Error && error.name === "ConditionalCheckFailedException") {
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
    updatedAt: new Date().toISOString(),
  };
  await repo.update(updated);
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
