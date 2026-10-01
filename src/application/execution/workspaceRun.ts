import type { AgentRepository } from "@/domain/agent/repository";
import type { Workspace } from "@/domain/workspace/types";
import type { RunActor, RunUser } from "@/domain/execution/actor";
import { ValidationError } from "@/application/errors";
import { assertAgentAccessible } from "@/application/agent/agentUseCases";
import { openTaskRun, type RunBracketDeps } from "@/application/run/runBracket";

/** Run bracket for coding jobs and ordinary commands in persistent Workspace sandboxes. */
export async function executeWorkspaceTask(
  deps: RunBracketDeps,
  agents: AgentRepository,
  workspace: Workspace,
  work: () => Promise<boolean>,
  actor: RunActor,
  user: RunUser,
): Promise<void> {
  if (!user?.userId || user.email !== workspace.ownerEmail || !actor?.id) throw new ValidationError("Workspace task has no authenticated caller");
  const agent = await assertAgentAccessible(agents, workspace.agentName, workspace.ownerEmail);
  const bracket = await openTaskRun(deps, agent, actor);
  let failed = false;
  try { failed = await work(); }
  catch (error) { failed = true; throw error; }
  finally { await bracket.close({ failed }); }
}
