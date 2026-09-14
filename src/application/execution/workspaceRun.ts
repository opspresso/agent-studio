import type { ProjectRepository } from "@/domain/project/repository";
import type { Workspace } from "@/domain/workspace/types";
import { assertProjectAccessible } from "@/application/project/projectUseCases";
import { openTaskRun, type RunBracketDeps } from "@/application/run/runBracket";

/** Execution facade for externally hosted workspace runtimes and ordinary sandbox jobs. */
export async function executeWorkspaceTask(
  deps: RunBracketDeps,
  projects: ProjectRepository,
  workspace: Workspace,
  work: () => Promise<boolean>,
): Promise<void> {
  const project = await assertProjectAccessible(projects, workspace.projectName, workspace.ownerEmail);
  const bracket = await openTaskRun(deps, project, { kind: "user", id: workspace.ownerEmail });
  let failed = false;
  try { failed = await work(); }
  catch (error) { failed = true; throw error; }
  finally { await bracket.close({ failed }); }
}
