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
import type { Project } from "@/domain/project/types";
import type { SecretCipher } from "@/domain/security/secretCipher";
import { log } from "@/shared/logger";
import {
  assertProjectAccessible,
  createProject,
} from "./projectUseCases";
import { resolveRunnableVersion } from "./resolveRunnableVersion";
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

export interface CloneProjectResult {
  project: Project;
  /**
   * What the clone could not carry, when something. The project row exists
   * either way — failing the whole clone over the version would answer 500
   * for a project the console can already show — but silent loss is the bug,
   * so the caller is told rather than left to notice the missing version.
   */
  warning?: string;
}

export function composeCloneProject(
  deps: CloneProjectFlowDeps,
): (input: CloneProjectInput) => Promise<CloneProjectResult> {
  return async (input) => {
    // The visibility gate: cloning is one of the things "access" grants.
    const source = await assertProjectAccessible(deps.projects, input.sourceName, input.userEmail);
    // What the source actually stands behind — the published version, else its
    // newest draft. `resolveRunnableVersion` owns that rule; a second sort here
    // is how a clone would drift from what the source runs.
    const copied = await resolveRunnableVersion(deps.versions, source, {
      allowDraftFallback: true,
    });

    const project = await createProject(deps.projects, {
      name: input.name,
      displayName: input.displayName,
      description: source.description,
      projectType: source.projectType,
      ownerEmail: input.userEmail,
      departmentCode: source.departmentCode,
      // A private source clones private (with an empty invite list — the new
      // owner chooses their own). Defaulting to public would let any invitee
      // republish the private prompt to the whole org in one click.
      visibility: source.visibility,
    });

    if (!copied) {
      return { project };
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
      // A reference the source held may not be available to the cloner (a
      // private subagent), or its model may have left the catalog.
      const reason = error instanceof Error ? error.message : "unknown error";
      log.warn("version", `clone of "${input.sourceName}" as "${input.name}" starts without a version`, error);
      return {
        project,
        warning: `The source's version could not be copied (${reason}); the clone starts without one.`,
      };
    }
    return { project };
  };
}
