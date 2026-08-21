/**
 * Cloning a project someone may access into a project they own: the project
 * row plus one version copied from the source — its published version when it
 * has one (that is the configuration the source stands behind), its newest
 * otherwise. Deliberately NOT published, for the same reason
 * `createProjectFlow` does not publish: publishing turns the external
 * surfaces on, and a clone should not be reachable before its new owner has
 * looked at it.
 *
 * What a clone carries is configuration, never credentials or standing: MCP
 * binding header overrides are dropped (they are the source owner's secrets),
 * and Slack/Telegram/Teams wiring, cost limits, the API token, the invite
 * list and the published pointer all stay behind.
 *
 * A sibling of `createProjectFlow.ts` for the same cycle reason: this imports
 * both the project and version slices, and neither imports it.
 */

import type { ProjectRepository, VersionRepository } from "@/domain/project/repository";
import type { Project, Version } from "@/domain/project/types";
import type { SecretCipher } from "@/domain/security/secretCipher";
import { log } from "@/shared/logger";
import {
  assertProjectAccessible,
  createProject,
} from "./projectUseCases";
import { createVersion, type VersionRefRepos } from "./versionUseCases";

export interface CloneProjectFlowDeps {
  projects: ProjectRepository;
  versions: VersionRepository;
  refs: VersionRefRepos;
  cipher: SecretCipher;
}

export interface CloneProjectInput {
  sourceName: string;
  /** The new project's slug — validated at the route like any create. */
  name: string;
  displayName: string;
  /** Becomes the clone's owner. */
  userEmail: string;
}

/** The version a clone copies: the published one, else the newest. */
function versionToCopy(source: Project, versions: Version[]): Version | undefined {
  if (source.publishedVersion) {
    const published = versions.find((v) => v.versionName === source.publishedVersion);
    if (published) {
      return published;
    }
  }
  return [...versions].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
}

export function composeCloneProject(
  deps: CloneProjectFlowDeps,
): (input: CloneProjectInput) => Promise<Project> {
  return async (input) => {
    // The visibility gate: cloning is one of the things "access" grants.
    const source = await assertProjectAccessible(deps.projects, input.sourceName, input.userEmail);
    const sourceVersions = await deps.versions.list(input.sourceName);

    const project = await createProject(deps.projects, {
      name: input.name,
      displayName: input.displayName,
      description: source.description,
      projectType: source.projectType,
      ownerEmail: input.userEmail,
      departmentCode: source.departmentCode,
    });

    const copied = versionToCopy(source, sourceVersions);
    if (!copied) {
      return project;
    }
    try {
      await createVersion(
        deps.versions,
        deps.projects,
        project.name,
        {
          systemPrompt: copied.systemPrompt,
          userPromptTemplate: copied.userPromptTemplate,
          model: copied.model,
          fallbackModel: copied.fallbackModel,
          parameters: copied.parameters,
          // Binding names and tool selections copy; header overrides do not —
          // their values are the source owner's secrets, and a clone that kept
          // them would hand those to whoever cloned.
          mcpList: copied.mcpList.map(({ headers: _dropped, ...binding }) => binding),
          skillList: copied.skillList,
          subagentList: copied.subagentList,
          maxTurn: copied.maxTurn,
        },
        input.userEmail,
        deps.refs,
        deps.cipher,
      );
    } catch (error) {
      // Same posture as createProjectFlow: the project row exists, so failing
      // here would answer 500 for a project the console can already show. A
      // reference the source held may no longer resolve, or its model may have
      // left the catalog; the clone starts versionless and says so.
      log.warn("version", `clone of "${input.sourceName}" as "${input.name}" starts without a version`, error);
    }
    return project;
  };
}
