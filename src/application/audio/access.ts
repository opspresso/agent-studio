import type { AgentRepository } from "@/domain/agent/repository";
import type { MemberTier } from "@/domain/member/tiers";
import { tierMayRunAgents } from "@/domain/member/tiers";
import { assertAgentAccessible } from "@/application/agent/agentUseCases";
import { ForbiddenError } from "@/application/errors";

/** Audio work uses the caller's member access; individual files and jobs retain their own ownership. */
export async function assertAudioAccessible(
  deps: { agents: AgentRepository; memberTier(email: string): Promise<MemberTier | null> },
  agentName: string,
  email: string,
) {
  const [agent, tier] = await Promise.all([
    assertAgentAccessible(deps.agents, agentName, email), deps.memberTier(email),
  ]);
  if (!tier || !tierMayRunAgents(tier)) throw new ForbiddenError("Audio processing requires an active member account");
  return agent;
}
