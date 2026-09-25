import type { AgentRepository } from "@/domain/agent/repository";
import type { Workspace } from "@/domain/workspace/types";
import { assertAgentAccessible } from "@/application/agent/agentUseCases";
import { openTaskRun, type RunBracketDeps } from "@/application/run/runBracket";

/** Execution facade for externally hosted workspace runtimes and ordinary sandbox jobs. */
export async function executeWorkspaceTask(
  deps: RunBracketDeps,
  agents: AgentRepository,
  workspace: Workspace,
  work: () => Promise<boolean>,
): Promise<void> {
  const agent = await assertAgentAccessible(agents, workspace.agentName, workspace.ownerEmail);
  const bracket = await openTaskRun(deps, agent, { kind: "user", id: workspace.ownerEmail });
  let failed = false;
  try { failed = await work(); }
  catch (error) { failed = true; throw error; }
  finally { await bracket.close({ failed }); }
}
