import { ValidationError } from "@/application/errors";
import { persistAgentUpdate } from "@/application/agent/agentUpdate";
import { assertAgentOwnerOrAdminReadable, assertAgentWritable } from "@/application/agent/agentUseCases";
import { nextUpdatedAt } from "@/shared/nextUpdatedAt";
import type { SecretCipher } from "@/domain/security/secretCipher";
import type { Agent, TeamsIntegration } from "@/domain/agent/types";
import type { AgentRepository } from "@/domain/agent/repository";
import type { TeamsCredentials } from "@/domain/teams/client";
import { teamsSecretContext } from "@/domain/security/secretContext";

/**
 * An agent's Microsoft Teams bot: what the console reads and writes, and what
 * the messaging endpoint needs at dispatch.
 *
 * Both credentials are the operator's, from an Azure Bot registration: the
 * **App ID** the Bot Framework names as the audience of every delivery it
 * signs, and the **client secret** this platform trades for a token to answer
 * with. Nothing is minted here, and — unlike Telegram — nothing is registered
 * from here: Azure has no call to point a bot's messaging endpoint at an
 * address, so the console shows the address and the operator pastes it into
 * the registration.
 */

export interface AgentTeamsView {
  enabled: boolean;
  configured: boolean;
  /** Not a secret: the App ID is in every token's audience claim. */
  appId: string;
  /** Masked. */
  appPassword: string;
  tenantId: string;
  messagingPath: string;
}

export interface AgentTeamsUpdate {
  appId?: string;
  appPassword?: string;
  tenantId?: string;
  enabled?: boolean;
}

export function messagingPathFor(agentName: string): string {
  return `/api/teams/messages/${agentName}`;
}

function maskedView(cipher: SecretCipher, agent: Agent): AgentTeamsView {
  const teams = agent.teams;
  return {
    enabled: teams?.enabled ?? false,
    configured: Boolean(teams?.appId && teams.appPassword),
    appId: teams?.appId ?? "",
    appPassword: teams?.appPassword
      ? cipher.mask(teams.appPassword, teamsSecretContext(agent.name))
      : "",
    tenantId: teams?.tenantId ?? "",
    messagingPath: messagingPathFor(agent.name),
  };
}

export interface AgentTeamsResult {
  agent: Agent;
  view: AgentTeamsView;
}

/**
 * Owner or admin, unlike the shared agent catalog: this exposes the masked
 * secret. Checked here rather than at the route so no verb can be added
 * without it.
 */
export async function getAgentTeams(
  repo: AgentRepository,
  name: string,
  userEmail: string,
  cipher: SecretCipher,
): Promise<AgentTeamsResult> {
  const agent = await assertAgentOwnerOrAdminReadable(repo, name, userEmail);
  return { agent, view: maskedView(cipher, agent) };
}

/** A GUID, which is what an App ID and a tenant id are. */
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Save the registration, or turn the bot on or off. A masked or empty secret
 * keeps what is stored (a mask can only confirm a secret, never create one);
 * the App ID is not a secret and is stored as typed. Nothing is checked with
 * Microsoft here — the *test* endpoint is what proves a pair works, and it is
 * a network call the operator asks for rather than one a save makes.
 */
export async function updateAgentTeams(
  repo: AgentRepository,
  name: string,
  update: AgentTeamsUpdate,
  userEmail: string,
  cipher: SecretCipher,
): Promise<AgentTeamsResult> {
  const agent = await assertAgentWritable(repo, name, userEmail);
  const stored = agent.teams;
  // Lower-cased, because the Bot Framework writes the same GUID lower-case
  // into every token's audience and a pasted upper-case one must still match.
  const appId = (update.appId ?? stored?.appId ?? "").trim().toLowerCase();
  if (appId && !GUID.test(appId)) {
    throw new ValidationError("The Microsoft App ID is a GUID");
  }
  const tenantId = (update.tenantId ?? stored?.tenantId ?? "").trim().toLowerCase();
  if (tenantId && !GUID.test(tenantId)) {
    throw new ValidationError("The tenant id is a GUID");
  }
  const incoming = update.appPassword;
  const appPassword =
    incoming === undefined || incoming === "" || cipher.isMasked(incoming)
      ? (stored?.appPassword ?? "")
      : cipher.encrypt(incoming.trim(), teamsSecretContext(name));
  const teams: TeamsIntegration = {
    appId,
    appPassword,
    enabled: update.enabled ?? stored?.enabled ?? false,
    ...(tenantId ? { tenantId } : {}),
  };
  if (teams.enabled && (!teams.appId || !teams.appPassword)) {
    throw new ValidationError("An App ID and a client secret are required to enable Teams");
  }
  const updated: Agent = { ...agent, teams, updatedAt: nextUpdatedAt(agent.updatedAt) };
  await persistAgentUpdate(repo, updated, agent.updatedAt);
  return { agent: updated, view: maskedView(cipher, updated) };
}

/** Forget the registration. Nothing to tell Azure — the endpoint there is the operator's to remove. */
export async function disconnectAgentTeams(
  repo: AgentRepository,
  name: string,
  userEmail: string,
  cipher: SecretCipher,
): Promise<AgentTeamsResult> {
  const agent = await assertAgentWritable(repo, name, userEmail);
  const updated: Agent = { ...agent, teams: undefined, updatedAt: nextUpdatedAt(agent.updatedAt) };
  await persistAgentUpdate(repo, updated, agent.updatedAt);
  return { agent: updated, view: maskedView(cipher, updated) };
}

/** Decrypt credentials for runtime use, for an enabled bot. Only call at dispatch time. */
export function resolveAgentTeamsRuntime(
  cipher: SecretCipher,
  agent: Agent,
): TeamsCredentials | null {
  const teams = agent.teams;
  if (!teams?.enabled || !teams.appId || !teams.appPassword) {
    return null;
  }
  return {
    appId: teams.appId,
    appPassword: cipher.decrypt(teams.appPassword, teamsSecretContext(agent.name)),
    ...(teams.tenantId ? { tenantId: teams.tenantId } : {}),
  };
}

/**
 * Prove the stored registration works: acquire a token with it. Owner-gated by
 * the caller; `authenticate` is injected so this stays free of the HTTP client.
 */
export async function testAgentTeams(
  repo: AgentRepository,
  name: string,
  userEmail: string,
  cipher: SecretCipher,
  authenticate: (credentials: TeamsCredentials) => Promise<{ expiresInSeconds: number }>,
): Promise<{ ok: true; appId: string; expiresInSeconds: number } | { ok: false }> {
  const agent = await assertAgentOwnerOrAdminReadable(repo, name, userEmail);
  const runtime = resolveAgentTeamsRuntime(cipher, agent);
  if (!runtime) {
    return { ok: false };
  }
  const token = await authenticate(runtime);
  return { ok: true, appId: runtime.appId, expiresInSeconds: token.expiresInSeconds };
}

/**
 * What one activity on this agent's endpoint needs before it can be
 * handled: the credentials to verify it against and answer with. Null when the
 * agent is missing or its bot is not enabled. No session is involved — the
 * Bot Framework's token is the authentication.
 */
export interface TeamsEventBinding {
  agentName: string;
  credentials: TeamsCredentials;
}

export async function resolveTeamsEventBinding(
  repo: AgentRepository,
  agentName: string,
  cipher: SecretCipher,
): Promise<TeamsEventBinding | null> {
  const agent = await repo.get(agentName);
  const runtime = agent ? resolveAgentTeamsRuntime(cipher, agent) : null;
  if (!agent || !runtime) {
    return null;
  }
  return { agentName: agent.name, credentials: runtime };
}

export interface AgentTeamsUseCases {
  get(name: string, userEmail: string): Promise<AgentTeamsResult>;
  update(name: string, update: AgentTeamsUpdate, userEmail: string): Promise<AgentTeamsResult>;
  disconnect(name: string, userEmail: string): Promise<AgentTeamsResult>;
  test(
    name: string,
    userEmail: string,
  ): Promise<{ ok: true; appId: string; expiresInSeconds: number } | { ok: false }>;
  /** No session involved — the Bot Framework token is the authentication. */
  resolveEventBinding(agentName: string): Promise<TeamsEventBinding | null>;
}

export function createAgentTeamsUseCases(deps: {
  agents: AgentRepository;
  cipher: SecretCipher;
  authenticate: (credentials: TeamsCredentials) => Promise<{ expiresInSeconds: number }>;
}): AgentTeamsUseCases {
  return {
    get: (name, userEmail) => getAgentTeams(deps.agents, name, userEmail, deps.cipher),
    update: (name, update, userEmail) =>
      updateAgentTeams(deps.agents, name, update, userEmail, deps.cipher),
    disconnect: (name, userEmail) => disconnectAgentTeams(deps.agents, name, userEmail, deps.cipher),
    test: (name, userEmail) =>
      testAgentTeams(deps.agents, name, userEmail, deps.cipher, deps.authenticate),
    resolveEventBinding: (agentName) => resolveTeamsEventBinding(deps.agents, agentName, deps.cipher),
  };
}
