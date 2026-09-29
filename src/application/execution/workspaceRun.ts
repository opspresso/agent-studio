import type { AgentRepository } from "@/domain/agent/repository";
import type { Workspace } from "@/domain/workspace/types";
import type { RunActor } from "@/domain/execution/actor";
import { assertAgentAccessible } from "@/application/agent/agentUseCases";
import { openTaskRun, type RunBracketDeps } from "@/application/run/runBracket";

/** Run bracket for coding jobs and ordinary commands in persistent Workspace sandboxes. */
export async function executeWorkspaceTask(
  deps: RunBracketDeps,
  agents: AgentRepository,
  workspace: Workspace,
  work: () => Promise<boolean>,
  actor?: RunActor,
): Promise<void> {
  const agent = await assertAgentAccessible(agents, workspace.agentName, workspace.ownerEmail);
  const bracket = await openTaskRun(deps, agent, actor ?? { kind: "user", id: workspace.ownerEmail });
  let failed = false;
  try { failed = await work(); }
  catch (error) { failed = true; throw error; }
  finally { await bracket.close({ failed }); }
}
