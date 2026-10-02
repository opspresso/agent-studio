import type { AgentRepository } from "@/domain/agent/repository";
import type { AgentConfiguration, CostLimits, Agent, AgentVisibility } from "@/domain/agent/types";
import { isAgentOwner, mayAccessAgent } from "@/domain/agent/access";
import { ConflictError, ForbiddenError, NotFoundError, isConditionalWriteFailure } from "@/application/errors";
import { nextUpdatedAt } from "@/shared/nextUpdatedAt";
import { persistAgentUpdate } from "./agentUpdate";
import { log } from "@/shared/logger";
import { auditTarget, recordAudit } from "@/application/audit/recordAudit";

export interface CreateAgentInput {
  name: string;
  displayName: string;
  description: string;
  configuration?: Omit<AgentConfiguration, "agentName">;
  ownerEmail: string;
  departmentCode?: string;
  /**
   * Not offered by the console's create form (a new agent starts public, as
   * every agent always has); a clone passes the source's, so cloning a
   * private agent cannot quietly republish its prompt to the whole org.
   */
  visibility?: AgentVisibility;
}

export interface UpdateAgentInput {
  displayName?: string;
  description?: string;
  departmentCode?: string;
  /** Replaces the stored guards; `null` removes them. Absent leaves them alone. */
  costLimits?: CostLimits | null;
  visibility?: AgentVisibility;
}

export const AGENT_LIST_PAGE_SIZE = 100;

export async function listAgents(repo: Pick<AgentRepository, "list">): Promise<Agent[]> {
  const agents: Agent[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await repo.list(AGENT_LIST_PAGE_SIZE, after);
    agents.push(...page);
    if (page.length < AGENT_LIST_PAGE_SIZE) {
      return agents;
    }
    after = page.at(-1)!.name;
  }
}

/** Read the public catalog and the caller's own private Agents. */
export async function listAccessibleAgents(
  repo: AgentRepository,
  userEmail: string,
): Promise<Agent[]> {
  const agents = await listAgents(repo);
  return agents.filter((agent) => mayAccessAgent(agent, userEmail));
}

export async function getAgent(repo: AgentRepository, name: string): Promise<Agent> {
  const agent = await repo.get(name);
  if (!agent) {
    throw new NotFoundError(`Agent "${name}" not found`);
  }
  return agent;
}

/** Shared Agent use does not grant management access, including to administrators. */
export async function assertAgentOwner(
  repo: Pick<AgentRepository, "get">,
  name: string,
  userEmail: string,
  options?: { includeDeleting?: boolean },
): Promise<Agent> {
  const agent = await repo.get(name, options);
  if (!agent) throw new NotFoundError(`Agent "${name}" not found`);
  if (!isAgentOwner(agent, userEmail)) throw new ForbiddenError(`Only the owner can manage agent "${name}"`);
  return agent;
}

/** Visibility applies to every caller, including administrators and automation. */
export async function assertAgentAccessible(
  repo: AgentRepository,
  name: string,
  userEmail: string,
): Promise<Agent> {
  const agent = await getAgent(repo, name);
  if (mayAccessAgent(agent, userEmail)) {
    return agent;
  }
  throw new ForbiddenError(`Agent "${name}" is private`);
}

export async function createAgent(
  repo: AgentRepository,
  input: CreateAgentInput,
): Promise<Agent> {
  const existing = await repo.get(input.name);
  if (existing) {
    throw new ConflictError(`Agent "${input.name}" already exists`);
  }

  const now = new Date().toISOString();
  const agent: Agent = {
    name: input.name,
    displayName: input.displayName,
    description: input.description,
    ...(input.configuration ? { configuration: { ...structuredClone(input.configuration), agentName: input.name } } : {}),
    ownerEmail: input.ownerEmail,
    departmentCode: input.departmentCode,
    ...(input.visibility ? { visibility: input.visibility } : {}),
    createdAt: now,
    updatedAt: now,
  };
  try {
    await repo.create(agent);
  } catch (error) {
    // The repository's conditional put loses a create race the pre-check missed.
    if (isConditionalWriteFailure(error)) {
      throw new ConflictError(`Agent "${input.name}" already exists`);
    }
    throw error;
  }
  return agent;
}

export async function updateAgent(
  repo: AgentRepository,
  name: string,
  input: UpdateAgentInput,
  userEmail: string,
): Promise<Agent> {
  const existing = await assertAgentOwner(repo, name, userEmail);
  const updated: Agent = {
    ...existing,
    displayName: input.displayName ?? existing.displayName,
    description: input.description ?? existing.description,
    departmentCode: input.departmentCode ?? existing.departmentCode,
    // Three-state on purpose: absent keeps, `null` clears, an object replaces.
    // `??` alone cannot express the clear, and a spread merge could not remove
    // one threshold while keeping the other.
    ...(input.costLimits === undefined
      ? {}
      : input.costLimits === null
        ? { costLimits: undefined }
        : { costLimits: input.costLimits }),
    ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
    updatedAt: nextUpdatedAt(existing.updatedAt),
  };
  await persistAgentUpdate(repo, updated, existing.updatedAt);
  return updated;
}

/**
 * What has to happen outside the table before an agent's rows go: today, the
 * agent's Telegram bot webhook, whose token is on the row about to be deleted.
 * Injected by the composition root; the agent slice does not know Telegram.
 */
export type BeforeAgentDelete = (agent: Agent) => Promise<void>;

/** Delete an agent. The repository removes agent-owned rows and reserves its name. */
export async function deleteAgent(
  repo: AgentRepository,
  name: string,
  userEmail: string,
  beforeDelete?: BeforeAgentDelete,
): Promise<void> {
  const agent = await assertAgentOwner(repo, name, userEmail, { includeDeleting: true });
  // Before the row goes, while what it holds can still be acted on — and best
  // effort by contract: nothing the hook does may make an agent undeletable.
  // The hook already catches its own network failure; this catches the rest
  // (a credential that no longer decrypts is the case that would otherwise
  // pin the agent forever).
  try {
    await beforeDelete?.(agent);
  } catch (error) {
    log.warn("agent", `pre-delete hook failed for ${name}; deleting anyway`, error);
  }
  await repo.delete(name);
  // After the delete, and the one record that survives it: the cascade takes
  // every row that could otherwise have said who the agent belonged to.
  await recordAudit({
    actorEmail: userEmail,
    action: "agent.delete",
    target: auditTarget("agent", name),
    detail: `owned by ${agent.ownerEmail}`,
  });
}

/**
 * The slice bound to its repository, composed once by the composition root.
 *
 * **Which form to use is not a preference.** A route handler takes the bound
 * object; a use case that already holds the repository calls the function
 * directly. The functions above are the implementation, and they stay exported
 * because `triggerUseCases`, `mcpAuthUseCases` and `agentSlack` each hold a
 * `AgentRepository` of their own already — passing it to a sibling inside the
 * same layer is ordinary, and handing those three a second object holding the
 * repository they were injected with would be the indirection, not the fix.
 *
 * `tests/architecture.test.ts` keeps agentRepository out of route handlers
 * and limits composition to the declared wiring sites.
 */
export interface AgentUseCases {
  list(): Promise<Agent[]>;
  /** See {@link listAccessibleAgents} — what this person's console may show. */
  listAccessible(userEmail: string): Promise<Agent[]>;
  get(name: string): Promise<Agent>;
  /** See {@link assertAgentAccessible} — public visibility or private ownership. */
  assertAccessible(name: string, userEmail: string): Promise<Agent>;
  create(input: CreateAgentInput): Promise<Agent>;
  update(name: string, input: UpdateAgentInput, userEmail: string): Promise<Agent>;
  remove(name: string, userEmail: string): Promise<void>;
}

export function createAgentUseCases(
  agents: AgentRepository,
  hooks: { beforeDelete?: BeforeAgentDelete } = {},
): AgentUseCases {
  return {
    list: () => listAgents(agents),
    listAccessible: (userEmail) => listAccessibleAgents(agents, userEmail),
    get: (name) => getAgent(agents, name),
    assertAccessible: (name, userEmail) => assertAgentAccessible(agents, name, userEmail),
    create: (input) => createAgent(agents, input),
    update: (name, input, userEmail) => updateAgent(agents, name, input, userEmail),
    remove: (name, userEmail) => deleteAgent(agents, name, userEmail, hooks.beforeDelete),
  };
}
