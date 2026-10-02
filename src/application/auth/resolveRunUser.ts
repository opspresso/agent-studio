import type { AgentRepository } from "@/domain/agent/repository";
import type { MemberRepository } from "@/domain/member/repository";
import type { RunUser } from "@/domain/execution/actor";
import { tierMayRunAgents } from "@/domain/member/tiers";
import { assertAgentAccessible } from "@/application/agent/agentUseCases";
import { ForbiddenError } from "@/application/errors";

export interface RunUserDeps {
  agents: AgentRepository;
  members: Pick<MemberRepository, "getById">;
}

/** Resolve only an authenticated or persistently captured ID; never adopt an account by email. */
export async function resolveAgentCaller(
  deps: RunUserDeps,
  agentName: string,
  userId: string,
) {
  if (!userId) throw new ForbiddenError("An authenticated Studio user is required");
  const member = await deps.members.getById(userId);
  if (!member || member.id !== userId) throw new ForbiddenError("The execution user is no longer active");
  if (!tierMayRunAgents(member.tier)) {
    throw new ForbiddenError("Agent execution requires member access");
  }
  const agent = await assertAgentAccessible(deps.agents, agentName, member.email);
  return { user: { userId: member.id, email: member.email }, agent };
}

export async function resolveRunUser(deps: RunUserDeps, agentName: string, userId: string): Promise<RunUser> {
  return (await resolveAgentCaller(deps, agentName, userId)).user;
}
