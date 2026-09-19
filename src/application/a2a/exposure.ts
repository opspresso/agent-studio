/**
 * Which projects are exposed over A2A, and the Agent Card each one publishes.
 *
 * This lived in four route handlers, each re-deriving "configured version → card"
 * and each reaching past {@link resolveRunnableVersion} to read the pointer
 * itself. That policy has one owner; a second copy is how an external surface
 * starts serving drafts. Routes now only choose status codes.
 */

import type { AgentCard } from "@a2a-js/sdk";
import type { ProjectRepository } from "@/domain/project/repository";
import type { Project, AgentConfiguration } from "@/domain/project/types";
import { listAccessibleProjects } from "@/application/project/projectUseCases";
import { mapWithLimit } from "@/shared/mapWithLimit";

export interface A2aExposureDeps {
  projects: ProjectRepository;
  /** Renders the Agent Card for a runnable project/version pair. */
  buildCard(project: Project): Promise<AgentCard>;
  /** Public URL of a project's Agent Card. */
  cardUrlFor(projectName: string): Promise<string>;
}

/** A project that is actually runnable over A2A, with the card it publishes. */
export interface ExposedProject {
  project: Project;
  configuration: AgentConfiguration;
  card: AgentCard;
}

export interface A2aProjectListItem {
  name: string;
  displayName: string;
  description: string;
  cardUrl: string;
}

/**
 * Resolve a project to its configured version and card, or null when either is
 * missing. Configured-only: A2A is an external surface, so a draft never leaks
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
  const configuration = project.configuration;
  if (!configuration) {
    return null;
  }
  return { project, configuration, card: await deps.buildCard(project) };
}

/**
 * Version lookups this listing keeps in flight.
 *
 * Deciding "is this one runnable" costs a read per project — the configured
 * pointer, or the version list behind a draft fallback — so the listing's cost
 * scales with the deployment rather than with the page. One `Promise.all` over
 * every accessible project opens that many database round trips at once, and
 * for an admin "every accessible project" is all of them.
 */
export const MAX_CONCURRENT_A2A_EXPOSURE_READS = 8;

/** Every project this viewer may see that is currently exposed over A2A. */
export async function listExposedProjects(
  deps: A2aExposureDeps,
  userEmail: string,
): Promise<A2aProjectListItem[]> {
  const projects = await listAccessibleProjects(deps.projects, userEmail);
  const exposed = await mapWithLimit(
    projects,
    MAX_CONCURRENT_A2A_EXPOSURE_READS,
    async (project) => {
      const configuration = project.configuration;
      if (!configuration) {
        return null;
      }
      return {
        name: project.name,
        displayName: project.displayName,
        description: project.description,
        cardUrl: await deps.cardUrlFor(project.name),
      };
    },
  );
  return exposed.filter((project): project is A2aProjectListItem => project !== null);
}

/** What the console shows on a project's A2A tab. Null when the project is gone. */
export async function describeProjectA2a(
  deps: A2aExposureDeps,
  name: string,
  a2aEnabled: boolean,
): Promise<{ configured: boolean; cardUrl: string | null; card: AgentCard | null } | null> {
  const project = await deps.projects.get(name);
  if (!project) {
    return null;
  }
  const configured = Boolean(project.configuration);
  // The card is built for any configured project so the console can preview it,
  // whether or not A2A_API_KEY is set on this deployment.
  const exposed = configured ? await exposeProject(deps, project) : null;
  return {
    configured,
    cardUrl: a2aEnabled && configured ? await deps.cardUrlFor(project.name) : null,
    card: exposed?.card ?? null,
  };
}
