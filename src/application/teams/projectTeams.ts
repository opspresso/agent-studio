import { ValidationError } from "@/application/errors";
import { persistProjectUpdate } from "@/application/project/projectUpdate";
import { assertProjectWritable } from "@/application/project/projectUseCases";
import { nextUpdatedAt } from "@/shared/nextUpdatedAt";
import type { SecretCipher } from "@/domain/security/secretCipher";
import type { Project, TeamsIntegration } from "@/domain/project/types";
import type { ProjectRepository } from "@/domain/project/repository";
import type { TeamsCredentials } from "@/domain/teams/client";
import { teamsSecretContext } from "@/domain/security/secretContext";

/**
 * A project's Microsoft Teams bot: what the console reads and writes, and what
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

export interface ProjectTeamsView {
  enabled: boolean;
  configured: boolean;
  /** Not a secret: the App ID is in every token's audience claim. */
  appId: string;
  /** Masked. */
  appPassword: string;
  tenantId: string;
  messagingPath: string;
}

export interface ProjectTeamsUpdate {
  appId?: string;
  appPassword?: string;
  tenantId?: string;
  enabled?: boolean;
}

export function messagingPathFor(projectName: string): string {
  return `/api/teams/messages/${projectName}`;
}

function maskedView(cipher: SecretCipher, project: Project): ProjectTeamsView {
  const teams = project.teams;
  return {
    enabled: teams?.enabled ?? false,
    configured: Boolean(teams?.appId && teams.appPassword),
    appId: teams?.appId ?? "",
    appPassword: teams?.appPassword
      ? cipher.mask(teams.appPassword, teamsSecretContext(project.name))
      : "",
    tenantId: teams?.tenantId ?? "",
    messagingPath: messagingPathFor(project.name),
  };
}

export interface ProjectTeamsResult {
  project: Project;
  view: ProjectTeamsView;
}

/**
 * Owner or admin, unlike the shared project catalog: this exposes the masked
 * secret. Checked here rather than at the route so no verb can be added
 * without it.
 */
export async function getProjectTeams(
  repo: ProjectRepository,
  name: string,
  userEmail: string,
  cipher: SecretCipher,
): Promise<ProjectTeamsResult> {
  const project = await assertProjectWritable(repo, name, userEmail);
  return { project, view: maskedView(cipher, project) };
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
export async function updateProjectTeams(
  repo: ProjectRepository,
  name: string,
  update: ProjectTeamsUpdate,
  userEmail: string,
  cipher: SecretCipher,
): Promise<ProjectTeamsResult> {
  const project = await assertProjectWritable(repo, name, userEmail);
  const stored = project.teams;
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
  const updated: Project = { ...project, teams, updatedAt: nextUpdatedAt(project.updatedAt) };
  await persistProjectUpdate(repo, updated, project.updatedAt);
  return { project: updated, view: maskedView(cipher, updated) };
}

/** Forget the registration. Nothing to tell Azure — the endpoint there is the operator's to remove. */
export async function disconnectProjectTeams(
  repo: ProjectRepository,
  name: string,
  userEmail: string,
  cipher: SecretCipher,
): Promise<ProjectTeamsResult> {
  const project = await assertProjectWritable(repo, name, userEmail);
  const updated: Project = { ...project, teams: undefined, updatedAt: nextUpdatedAt(project.updatedAt) };
  await persistProjectUpdate(repo, updated, project.updatedAt);
  return { project: updated, view: maskedView(cipher, updated) };
}

/** Decrypt credentials for runtime use, for an enabled bot. Only call at dispatch time. */
export function resolveProjectTeamsRuntime(
  cipher: SecretCipher,
  project: Project,
): TeamsCredentials | null {
  const teams = project.teams;
  if (!teams?.enabled || !teams.appId || !teams.appPassword) {
    return null;
  }
  return {
    appId: teams.appId,
    appPassword: cipher.decrypt(teams.appPassword, teamsSecretContext(project.name)),
    ...(teams.tenantId ? { tenantId: teams.tenantId } : {}),
  };
}

/**
 * Prove the stored registration works: acquire a token with it. Owner-gated by
 * the caller; `authenticate` is injected so this stays free of the HTTP client.
 */
export async function testProjectTeams(
  repo: ProjectRepository,
  name: string,
  userEmail: string,
  cipher: SecretCipher,
  authenticate: (credentials: TeamsCredentials) => Promise<{ expiresInSeconds: number }>,
): Promise<{ ok: true; appId: string; expiresInSeconds: number } | { ok: false }> {
  const project = await assertProjectWritable(repo, name, userEmail);
  const runtime = resolveProjectTeamsRuntime(cipher, project);
  if (!runtime) {
    return { ok: false };
  }
  const token = await authenticate(runtime);
  return { ok: true, appId: runtime.appId, expiresInSeconds: token.expiresInSeconds };
}

/**
 * What one activity on this project's endpoint needs before it can be
 * handled: the credentials to verify it against and answer with. Null when the
 * project is missing or its bot is not enabled. No session is involved — the
 * Bot Framework's token is the authentication.
 */
export interface TeamsEventBinding {
  projectName: string;
  credentials: TeamsCredentials;
}

export async function resolveTeamsEventBinding(
  repo: ProjectRepository,
  projectName: string,
  cipher: SecretCipher,
): Promise<TeamsEventBinding | null> {
  const project = await repo.get(projectName);
  const runtime = project ? resolveProjectTeamsRuntime(cipher, project) : null;
  if (!project || !runtime) {
    return null;
  }
  return { projectName: project.name, credentials: runtime };
}

export interface ProjectTeamsUseCases {
  get(name: string, userEmail: string): Promise<ProjectTeamsResult>;
  update(name: string, update: ProjectTeamsUpdate, userEmail: string): Promise<ProjectTeamsResult>;
  disconnect(name: string, userEmail: string): Promise<ProjectTeamsResult>;
  test(
    name: string,
    userEmail: string,
  ): Promise<{ ok: true; appId: string; expiresInSeconds: number } | { ok: false }>;
  /** No session involved — the Bot Framework token is the authentication. */
  resolveEventBinding(projectName: string): Promise<TeamsEventBinding | null>;
}

export function createProjectTeamsUseCases(deps: {
  projects: ProjectRepository;
  cipher: SecretCipher;
  authenticate: (credentials: TeamsCredentials) => Promise<{ expiresInSeconds: number }>;
}): ProjectTeamsUseCases {
  return {
    get: (name, userEmail) => getProjectTeams(deps.projects, name, userEmail, deps.cipher),
    update: (name, update, userEmail) =>
      updateProjectTeams(deps.projects, name, update, userEmail, deps.cipher),
    disconnect: (name, userEmail) => disconnectProjectTeams(deps.projects, name, userEmail, deps.cipher),
    test: (name, userEmail) =>
      testProjectTeams(deps.projects, name, userEmail, deps.cipher, deps.authenticate),
    resolveEventBinding: (projectName) => resolveTeamsEventBinding(deps.projects, projectName, deps.cipher),
  };
}
