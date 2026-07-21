import type { Project, Version } from "./types";

export interface ProjectRepository {
  get(name: string): Promise<Project | null>;
  list(): Promise<Project[]>;
  create(project: Project): Promise<void>;
  update(project: Project): Promise<void>;
  delete(name: string): Promise<void>;
}

export interface VersionRepository {
  /** versionName may be the literal "published", resolved via the project's pointer. */
  get(projectName: string, versionName: string): Promise<Version | null>;
  list(projectName: string): Promise<Version[]>;
  put(version: Version): Promise<void>;
  delete(projectName: string, versionName: string): Promise<void>;
}
