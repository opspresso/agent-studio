import type { AgentRepository } from "@/domain/agent/repository";
import type { AgentConfiguration, CostLimits, Agent, AgentVisibility } from "@/domain/agent/types";
import { mayAccessAgent, normalizeMemberEmails } from "@/domain/agent/access";
import { ConflictError, ForbiddenError, NotFoundError, isConditionalWriteFailure } from "@/application/errors";
import { nextUpdatedAt } from "@/shared/nextUpdatedAt";
import { persistAgentUpdate } from "./agentUpdate";
import { log } from "@/shared/logger";
import { auditTarget, recordAudit } from "@/application/audit/recordAudit";

/** The admin-list reader the write override consults. See {@link setAdminCheck}. */
type AdminCheck = (userEmail: string) => Promise<boolean>;

/**
 * Deny until wired: a composition that forgot the check keeps plain owner-only
 * writes — the same posture as a deployment with no admin list — rather than
 * opening every agent or crashing.
 */
const ADMIN_CHECK = Symbol.for("opspresso.agent-studio.agent-admin-check");
const denyAdmin: AdminCheck = async () => false;
type AgentProcessGlobal = typeof globalThis & { [ADMIN_CHECK]?: AdminCheck };

function adminCheck(): AdminCheck {
  return (globalThis as AgentProcessGlobal)[ADMIN_CHECK] ?? denyAdmin;
}

/**
 * Wire the admin-list reader the override consults. Called once by the
 * composition root. Pushed in rather than imported, because the reader lives in
 * `lib/runtime-settings` on top of the settings store — a static import here
 * would pull the database client into the application layer through the side
 * door. And pushed once rather than threaded through call sites, because a
 * caller that forgot the argument would silently narrow the rule back to
 * owner-only for its path alone.
 */
export function setAdminCheck(check: AdminCheck): void {
  (globalThis as AgentProcessGlobal)[ADMIN_CHECK] = check;
}

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
  /** Replaces the invite list; absent leaves it alone. Normalized on write. */
  memberEmails?: string[];
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

/**
 * The agents `userEmail` may see: everything public, plus the private ones
 * they own or are invited to — or everything, for an admin, who could reach
 * each one through the write override anyway and administers the catalog as a
 * whole. One admin check for the whole list, not one per row.
 */
export async function listAccessibleAgents(
  repo: AgentRepository,
  userEmail: string,
): Promise<Agent[]> {
  const agents = await listAgents(repo);
  if (await isAdminOverride(userEmail)) {
    return agents;
  }
  return agents.filter((agent) => mayAccessAgent(agent, userEmail));
}

export async function getAgent(repo: AgentRepository, name: string): Promise<Agent> {
  const agent = await repo.get(name);
  if (!agent) {
    throw new NotFoundError(`Agent "${name}" not found`);
  }
  return agent;
}

/**
 * Load an agent and assert `userEmail` may write it. Agents are a shared
 * catalog — anyone the visibility admits may read and run them
 * ({@link assertAgentAccessible}); writing is for the owner and for admins,
 * on either visibility.
 *
 * Named for what it checks, not for the owner alone: it is bound at twenty-odd
 * call sites, and while it asserted ownership the name was the documentation.
 * Anything that ever needs *ownership* specifically — attributing a quota,
 * choosing whose credentials to dispatch with, deciding whom to notify — must
 * read `agent.ownerEmail` and not reach for this.
 *
 * The admin case is checked here rather than threaded through those call sites
 * as a flag: the rule is "owner or admin", and a flag any one caller forgot to
 * pass would silently narrow it back to owner-only for that path alone.
 * The wired check ({@link setAdminCheck}) reads the effective admin list, so
 * demoting an admin on the settings page takes effect without a redeploy — and
 * it is the *configured* check, so a deployment with no admin list keeps plain
 * owner-only writes rather than opening every agent to everyone.
 */
export async function assertAgentWritable(
  repo: AgentRepository,
  name: string,
  userEmail: string,
): Promise<Agent> {
  const { agent, override } = await ownerOrAdminAccess(repo, name, userEmail);
  if (override) {
    await recordAdminOverride(agent, userEmail);
  }
  return agent;
}

/** The owner cannot see an override from the agent data, so preserve it outside that row. */
async function recordAdminOverride(agent: Agent, userEmail: string): Promise<void> {
  await recordAudit({
    actorEmail: userEmail,
    action: "agent.admin-override",
    target: auditTarget("agent", agent.name),
    detail: `owned by ${agent.ownerEmail}`,
  });
}

/**
 * The same rule as {@link assertAgentWritable}, asked by a **read**.
 *
 * Not a second rule and not a wider one — owner or admin, exactly as above. The
 * only difference is that nothing is recorded, and that is the point: reaching
 * into someone else's agent to *change* it is an act worth an audit row,
 * while opening masked integration settings or runtime output is not. An admin
 * clicking through a gallery would otherwise write a row per click, each
 * claiming a write override that never happened, burying the trail the table
 * exists for. It is the position {@link assertAgentAccessible} already takes
 * for its own reads: logged, never audited.
 *
 * `assertAgentAccessible` is *not* the substitute — it admits everyone a
 * public agent admits, and owner-scoped settings and outputs are not public
 * because the agent is. Which is why this exists at all.
 */
export async function assertAgentOwnerOrAdminReadable(
  repo: AgentRepository,
  name: string,
  userEmail: string,
): Promise<Agent> {
  return (await ownerOrAdminAccess(repo, name, userEmail, undefined, "read")).agent;
}

/** Owner or admin, or the refusal. Says which, so only one caller records it. */
async function ownerOrAdminAccess(
  repo: AgentRepository,
  name: string,
  userEmail: string,
  options?: { includeDeleting?: boolean },
  operation: "read" | "write" = "write",
): Promise<{ agent: Agent; override: boolean }> {
  const agent = await repo.get(name, options);
  if (!agent) {
    throw new NotFoundError(`Agent "${name}" not found`);
  }
  if (agent.ownerEmail === userEmail) {
    return { agent, override: false };
  }
  if (await isAdminOverride(userEmail)) {
    log.warn(
      "authz",
      `admin ${userEmail} is ${operation === "read" ? "reading" : "acting on"} agent "${name}" owned by ${agent.ownerEmail}`,
    );
    return { agent, override: true };
  }
  throw new ForbiddenError(`You do not have permission to modify agent "${name}"`);
}

/**
 * Load an agent and assert `userEmail` may access it — the read-and-run
 * sibling of {@link assertAgentWritable}, asked by every console surface
 * that shows or runs an agent on a person's behalf. The domain predicate
 * (`mayAccessAgent`) is the rule; this adds the admin override, allowed for
 * the same reason admins may write: they administer the catalog. Unlike the
 * write override it is logged but not audited — a read changes nothing, so
 * there is no later question only an audit row could answer.
 *
 * API-token and integration paths deliberately never come here: a token is
 * the agent's own credential, and a bot the owner wired to a surface was
 * pointed there by the owner. The person-facing gate for those surfaces is
 * their own (the Slack pipeline checks the asker's email itself).
 */
export async function assertAgentAccessible(
  repo: AgentRepository,
  name: string,
  userEmail: string,
): Promise<Agent> {
  const agent = await getAgent(repo, name);
  if (await userMayAccessAgent(agent, userEmail)) {
    return agent;
  }
  throw new ForbiddenError(`Agent "${name}" is private`);
}

/**
 * The access predicate with the admin override folded in, for slices that
 * already hold the agent row — the chat use cases and the messaging
 * pipeline, which load the agent for the run they are about to start and
 * must not read it twice just to ask this. Everything else goes through
 * {@link assertAgentAccessible}.
 */
export async function userMayAccessAgent(agent: Agent, userEmail: string): Promise<boolean> {
  if (mayAccessAgent(agent, userEmail)) {
    return true;
  }
  if (await isAdminOverride(userEmail)) {
    log.warn(
      "authz",
      `admin ${userEmail} is accessing private agent "${agent.name}" owned by ${agent.ownerEmail}`,
    );
    return true;
  }
  return false;
}

/**
 * The admin override, resolved so that losing the settings store denies rather
 * than throws.
 *
 * Only a non-owner reaches this, and for a non-owner on a deployment with no
 * admin list the answer is "no" without any I/O at all. Letting a settings read
 * failure escape would turn the deterministic 403 that path has always returned
 * into a 500, so an outage would change *which* error an unauthorized caller
 * sees. Failing closed keeps the denial.
 */
async function isAdminOverride(userEmail: string): Promise<boolean> {
  try {
    return await adminCheck()(userEmail);
  } catch (error) {
    log.error("authz", "admin list unavailable; denying the override", error);
    return false;
  }
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
  const existing = await assertAgentWritable(repo, name, userEmail);
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
    ...(input.memberEmails === undefined
      ? {}
      : { memberEmails: normalizeMemberEmails(input.memberEmails, existing.ownerEmail) }),
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
  const { agent, override } = await ownerOrAdminAccess(repo, name, userEmail, {
    includeDeleting: true,
  });
  if (override) {
    await recordAdminOverride(agent, userEmail);
  }
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
  /** See {@link assertAgentAccessible} — visibility, membership, admin override. */
  assertAccessible(name: string, userEmail: string): Promise<Agent>;
  /** See {@link assertAgentWritable} — owner or admin, and the override is recorded. */
  assertWritable(name: string, userEmail: string): Promise<Agent>;
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
    assertWritable: (name, userEmail) => assertAgentWritable(agents, name, userEmail),
    create: (input) => createAgent(agents, input),
    update: (name, input, userEmail) => updateAgent(agents, name, input, userEmail),
    remove: (name, userEmail) => deleteAgent(agents, name, userEmail, hooks.beforeDelete),
  };
}
