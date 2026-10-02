import type { AgentRepository } from "@/domain/agent/repository";
import type { Workspace } from "@/domain/workspace/types";
import type { RunIdentity } from "@/domain/execution/actor";
import { ValidationError } from "@/application/errors";
import { assertAgentAccessible } from "@/application/agent/agentUseCases";
import { openTaskRun, type RunBracketDeps, type RunBracket, type RunSlotPersistence } from "@/application/run/runBracket";

/** Run bracket for coding jobs and ordinary commands in persistent Workspace sandboxes. */
export async function executeWorkspaceTask(
  deps: RunBracketDeps,
  agents: AgentRepository,
  workspace: Workspace,
  work: (admit: () => Promise<void>) => Promise<boolean>,
  identity: RunIdentity,
  persistentSlot?: RunSlotPersistence,
): Promise<void> {
  if (!identity.user?.userId || identity.user.email !== workspace.ownerEmail || !identity.actor?.id) throw new ValidationError("Workspace task has no authenticated caller");
  let bracket: Omit<RunBracket, "artifacts"> | undefined;
  const admit = async () => {
    if (bracket) return;
    const agent = await assertAgentAccessible(agents, workspace.agentName, workspace.ownerEmail);
    bracket = await openTaskRun(deps, agent, identity, persistentSlot);
  };
  let failed = false;
  try { failed = await work(admit); }
  catch (error) { failed = true; throw error; }
  finally { await bracket?.close({ failed, retainSlot: !!persistentSlot }); }
}
