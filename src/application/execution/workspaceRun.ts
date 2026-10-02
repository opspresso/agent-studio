import type { AgentRepository } from "@/domain/agent/repository";
import type { Workspace } from "@/domain/workspace/types";
import type { RunIdentity } from "@/domain/execution/actor";
import { ValidationError } from "@/application/errors";
import { assertAgentAccessible } from "@/application/agent/agentUseCases";
import { openTaskRun, type RunBracketDeps } from "@/application/run/runBracket";

/** Run bracket for coding jobs and ordinary commands in persistent Workspace sandboxes. */
export async function executeWorkspaceTask(
  deps: RunBracketDeps,
  agents: AgentRepository,
  workspace: Workspace,
  work: () => Promise<boolean>,
  identity: RunIdentity,
): Promise<void> {
  if (!identity.user?.userId || identity.user.email !== workspace.ownerEmail || !identity.actor?.id) throw new ValidationError("Workspace task has no authenticated caller");
  const agent = await assertAgentAccessible(agents, workspace.agentName, workspace.ownerEmail);
  const bracket = await openTaskRun(deps, agent, identity);
  let failed = false;
  try { failed = await work(); }
  catch (error) { failed = true; throw error; }
  finally { await bracket.close({ failed }); }
}
