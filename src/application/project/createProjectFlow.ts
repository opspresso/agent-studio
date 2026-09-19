/**
 * Creating a project the console can use immediately: the project row plus an
 * initial version "1" — empty prompts, the deployment's first offered model —
 * so chat and the run panel work from the first minute. Deliberately NOT
 * published: publishing is the gate that turns the external surfaces on (the
 * unauthenticated A2A card, webhook and schedule firings, Slack, the subagent
 * picker), and an empty prompt has no business on any of them.
 *
 * Its own module because the import has nowhere else to point:
 * `versionUseCases` already imports `assertProjectWritable` from
 * `projectUseCases`, so the project slice calling back into versions would be
 * a cycle. This file imports both, and neither imports it.
 */

import type { ModelConfig } from "@/domain/llm/models";
import type { ProjectRepository, VersionRepository } from "@/domain/project/repository";
import type { Project } from "@/domain/project/types";
import type { SecretCipher } from "@/domain/security/secretCipher";
import { log } from "@/shared/logger";
import { createProject, type CreateProjectInput } from "./projectUseCases";
import { modelFitsAgent } from "./modelCompatibility";
import { createVersion, type VersionRefRepos } from "./versionUseCases";

export interface CreateProjectFlowDeps {
  projects: ProjectRepository;
  versions: VersionRepository;
  refs: VersionRefRepos;
  cipher: SecretCipher;
  /** What this deployment offers for selection — `offeredModels` fed the runtime settings. */
  offered(): Promise<ModelConfig[]>;
}

/**
 * The capability a project type needs of its first model — the server-side
 * sibling of the console's per-type dropdown filter, and the same requirement
 * `assertModelSupports` enforces on save (an agent needs tools; a chat type
 * never starts on an image model).
 */
export function composeCreateProjectWithInitialVersion(
  deps: CreateProjectFlowDeps,
): (input: CreateProjectInput) => Promise<Project> {
  return async (input) => {
    const project = await createProject(deps.projects, input);
    const model = (await deps.offered())
      .find((candidate) => modelFitsAgent(candidate))?.id ?? null;
    if (model === null) {
      log.warn(
        "version",
        `no offered model fits an Agent; "${input.name}" starts without a version`,
      );
      return project;
    }
    try {
      await createVersion(
        deps.versions,
        deps.projects,
        project.name,
        {
          systemPrompt: "",
          userPromptTemplate: "",
          model,
          parameters: { piiFiltering: false },
          mcpList: [],
          skillList: [],
          subagentList: [],
        },
        input.ownerEmail,
        deps.refs,
        deps.cipher,
      );
    } catch (error) {
      // The project row is already written, so failing here would answer 500
      // for a project that exists. The console shows the missing version
      // plainly — the playground offers "Create version" exactly as before.
      log.warn("version", `initial version for "${input.name}" was not created`, error);
    }
    return project;
  };
}
