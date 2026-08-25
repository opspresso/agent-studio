/**
 * Which projects are exposed over A2A, and the Agent Card each one publishes.
 *
 * This lived in four route handlers, each re-deriving "published version → card"
 * and each reaching past {@link resolveRunnableVersion} to read the pointer
 * itself. That policy has one owner; a second copy is how an external surface
 * starts serving drafts. Routes now only choose status codes.
 */

import type { AgentCard } from "@a2a-js/sdk";
import type { ProjectRepository, VersionRepository } from "@/domain/project/repository";
import type { Project, Version } from "@/domain/project/types";
import { listAccessibleProjects } from "@/application/project/projectUseCases";
import { resolveRunnableVersion } from "@/application/project/resolveRunnableVersion";

export interface A2aExposureDeps {
  projects: ProjectRepository;
  versions: VersionRepository;
  /** Renders the Agent Card for a runnable project/version pair. */
  buildCard(project: Project, version: Version): Promise<AgentCard>;
  /** Public URL of a project's Agent Card. */
  cardUrlFor(projectName: string): Promise<string>;
}

/** A project that is actually runnable over A2A, with the card it publishes. */
export interface ExposedProject {
  project: Project;
  version: Version;
  card: AgentCard;
}

export interface A2aProjectListItem {
  name: string;
  displayName: string;
  description: string;
  cardUrl: string;
}

/**
 * Resolve a project to its published version and card, or null when either is
 * missing. Published-only: A2A is an external surface, so a draft never leaks
 * (`resolveRunnableVersion` owns that rule).
 */
export async function resolveExposedProject(
  deps: A2aExposureDeps,
  name: string,
): Promise<ExposedProject | null> {
  const project = await deps.projects.get(name);
  return project ? exposeProject(deps, project) : null;
}

/** The same rule applied to a project already in hand, so no caller reads twice. */
async function exposeProject(
  deps: A2aExposureDeps,
  project: Project,
): Promise<ExposedProject | null> {
  const version = await resolveRunnableVersion(deps.versions, project);
  if (!version) {
    return null;
  }
  return { project, version, card: await deps.buildCard(project, version) };
}

/** Every project this viewer may see that is currently exposed over A2A. */
export async function listExposedProjects(
  deps: A2aExposureDeps,
  userEmail: string,
): Promise<A2aProjectListItem[]> {
  const projects = await listAccessibleProjects(deps.projects, userEmail);
  const exposed = await Promise.all(
    projects.map(async (project) => {
      const version = await resolveRunnableVersion(deps.versions, project);
      if (!version) {
        return null;
      }
      return {
        name: project.name,
        displayName: project.displayName,
        description: project.description,
        cardUrl: await deps.cardUrlFor(project.name),
      };
    }),
  );
  return exposed.filter((project): project is A2aProjectListItem => project !== null);
}

/** What the console shows on a project's A2A tab. Null when the project is gone. */
export async function describeProjectA2a(
  deps: A2aExposureDeps,
  name: string,
  a2aEnabled: boolean,
): Promise<{ published: boolean; cardUrl: string | null; card: AgentCard | null } | null> {
  const project = await deps.projects.get(name);
  if (!project) {
    return null;
  }
  const published = Boolean(project.publishedVersion);
  // The card is built for any published project so the console can preview it,
  // whether or not A2A_API_KEY is set on this deployment.
  const exposed = published ? await exposeProject(deps, project) : null;
  return {
    published,
    cardUrl: a2aEnabled && published ? await deps.cardUrlFor(project.name) : null,
    card: exposed?.card ?? null,
  };
}
