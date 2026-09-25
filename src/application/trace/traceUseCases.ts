import type { AgentRepository } from "@/domain/agent/repository";
import type { ListTracesOptions, TraceRepository } from "@/domain/trace/repository";
import type { Trace } from "@/domain/trace/types";
import { NotFoundError } from "@/application/errors";
import { assertAgentOwnerOrAdminReadable } from "@/application/agent/agentUseCases";

export interface TraceReadDeps {
  traces: TraceRepository;
  agents: AgentRepository;
}

/**
 * An agent's recent traces. Traces hold other users' runtime inputs and
 * outputs, so unlike the shared agent catalog they are readable only by the
 * owner and by admins — the read asserts that before touching the store.
 */
export async function listAgentTraces(
  deps: TraceReadDeps,
  agentName: string,
  userEmail: string,
  options?: ListTracesOptions,
): Promise<Trace[]> {
  await assertAgentOwnerOrAdminReadable(deps.agents, agentName, userEmail);
  return deps.traces.listByAgent(agentName, options);
}

/**
 * One trace, authorized like the list. Which agent a trace belongs to is the
 * trace's own record: a caller authorized for one agent must not read
 * another's by guessing ids, so a trace stored under a different agent is the
 * same answer as no trace at all.
 */
export async function getAgentTrace(
  deps: TraceReadDeps,
  agentName: string,
  traceId: string,
  userEmail: string,
): Promise<Trace> {
  await assertAgentOwnerOrAdminReadable(deps.agents, agentName, userEmail);
  const trace = await deps.traces.get(traceId);
  if (!trace || trace.agentName !== agentName) {
    throw new NotFoundError("Trace not found");
  }
  return trace;
}

/**
 * The slice bound to its repositories, composed once by the composition root.
 * The free functions above stay exported for application modules that already
 * hold a repository; a route takes this object.
 */
export interface TraceUseCases {
  list(agentName: string, userEmail: string, options?: ListTracesOptions): Promise<Trace[]>;
  get(agentName: string, traceId: string, userEmail: string): Promise<Trace>;
}

export function createTraceUseCases(deps: TraceReadDeps): TraceUseCases {
  return {
    list: (agentName, userEmail, options) =>
      listAgentTraces(deps, agentName, userEmail, options),
    get: (agentName, traceId, userEmail) =>
      getAgentTrace(deps, agentName, traceId, userEmail),
  };
}
