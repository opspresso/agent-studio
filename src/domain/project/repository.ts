import type { Project, ProjectApiToken } from "./types";

export interface ProjectRepository {
  get(name: string, options?: { includeDeleting?: boolean }): Promise<Project | null>;
  /** Projects ordered by name, strictly after `after` when supplied. */
  list(limit: number, after?: string): Promise<Project[]>;
  create(project: Project): Promise<void>;
  update(project: Project, expectedUpdatedAt: string): Promise<void>;
  delete(name: string): Promise<void>;
  /** Read the project's API token record (hash + createdAt), or null if none. */
  getApiToken(name: string): Promise<ProjectApiToken | null>;
  /** Create or replace the project's API token record (regeneration overwrites). */
  setApiToken(name: string, token: ProjectApiToken): Promise<void>;
  /** Remove the project's API token record. */
  deleteApiToken(name: string): Promise<void>;
}
