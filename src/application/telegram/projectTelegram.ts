import { ConflictError, ValidationError, isConditionalWriteFailure } from "@/application/errors";
import { assertProjectWritable } from "@/application/project/projectUseCases";
import { nextUpdatedAt } from "@/application/project/timestamps";
import type { SecretCipher } from "@/domain/security/secretCipher";
import type { Project, TelegramIntegration } from "@/domain/project/types";
import type { ProjectRepository } from "@/domain/project/repository";
import { generateSecretValue } from "@/shared/generatedSecret";
import { log } from "@/shared/logger";

/**
 * A project's Telegram bot: what the console reads and writes, and what the
 * events endpoint needs at dispatch.
 *
 * Two credentials, and only one of them is the operator's. The **bot token**
 * is pasted in from BotFather. The **webhook secret** is minted here the first
 * time a token is saved and handed to Telegram alone, through `setWebhook`;
 * Telegram echoes it on every delivery, and that echo is the whole
 * authentication of the events endpoint. Nobody needs to read it back, so
 * nothing reveals it.
 */

/** Which updates the webhook asks Telegram for. Messages only: no edits, no channel posts, no callbacks. */
const ALLOWED_UPDATES = ["message"] as const;

export interface ProjectTelegramView {
  enabled: boolean;
  configured: boolean;
  /** Masked. */
  botToken: string;
  /** Not a secret: the bot's `@username`, once a token has been checked. */
  botUsername: string;
  webhookPath: string;
}

export interface ProjectTelegramUpdate {
  botToken?: string;
  enabled?: boolean;
}

/** What `getMe` says about a token, as far as this slice needs it. */
export interface TelegramBotIdentity {
  id: number;
  username?: string;
}

export function webhookPathFor(projectName: string): string {
  return `/api/telegram/webhook/${projectName}`;
}

function maskedView(cipher: SecretCipher, project: Project): ProjectTelegramView {
  const telegram = project.telegram;
  return {
    enabled: telegram?.enabled ?? false,
    configured: Boolean(telegram?.botToken && telegram.webhookSecret),
    botToken: telegram?.botToken ? cipher.mask(telegram.botToken) : "",
    botUsername: telegram?.botUsername ?? "",
    webhookPath: webhookPathFor(project.name),
  };
}

export interface ProjectTelegramResult {
  project: Project;
  view: ProjectTelegramView;
}

/**
 * Owner or admin, unlike the shared project catalog: this exposes the masked
 * bot token. Checked here rather than at the route so no verb can be added
 * without it.
 */
export async function getProjectTelegram(
  repo: ProjectRepository,
  name: string,
  userEmail: string,
  cipher: SecretCipher,
): Promise<ProjectTelegramResult> {
  const project = await assertProjectWritable(repo, name, userEmail);
  return { project, view: maskedView(cipher, project) };
}

async function updateProject(
  repo: ProjectRepository,
  updated: Project,
  expectedUpdatedAt: string,
): Promise<void> {
  try {
    await repo.update(updated, expectedUpdatedAt);
  } catch (error) {
    if (isConditionalWriteFailure(error)) {
      throw new ConflictError(`Project "${updated.name}" was modified by another request`);
    }
    throw error;
  }
}

/**
 * Save a token, or turn the bot on or off.
 *
 * A *new* token is checked with Telegram before it is stored — `getMe` is the
 * one call that costs nothing and says both whether the token is real and what
 * the bot is called, and the username is what a group mention is matched
 * against later. A masked or empty token keeps what is stored (a mask can only
 * confirm a secret, never create one). The webhook secret is minted with the
 * first token and kept across token changes: it is this platform's, not
 * Telegram's, and re-minting it would silently invalidate a webhook already
 * registered.
 */
export async function updateProjectTelegram(
  repo: ProjectRepository,
  name: string,
  update: ProjectTelegramUpdate,
  userEmail: string,
  cipher: SecretCipher,
  getMe: (botToken: string) => Promise<TelegramBotIdentity>,
): Promise<ProjectTelegramResult> {
  const project = await assertProjectWritable(repo, name, userEmail);
  if (project.projectType !== "agent") {
    throw new ValidationError("Telegram bots can only be attached to agent projects");
  }
  const stored = project.telegram;
  let botToken = stored?.botToken ?? "";
  let botUsername = stored?.botUsername;
  const incoming = update.botToken;
  if (incoming !== undefined && incoming !== "" && !cipher.isMasked(incoming)) {
    const token = incoming.trim();
    let identity: TelegramBotIdentity;
    try {
      identity = await getMe(token);
    } catch (error) {
      throw new ValidationError(
        `Telegram did not accept the bot token: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
    botToken = cipher.encrypt(token);
    botUsername = identity.username;
  }
  const telegram: TelegramIntegration = {
    botToken,
    webhookSecret: stored?.webhookSecret ?? cipher.encrypt(generateSecretValue("telegramWebhookSecret")),
    enabled: update.enabled ?? stored?.enabled ?? false,
    ...(botUsername ? { botUsername } : {}),
  };
  if (telegram.enabled && !telegram.botToken) {
    throw new ValidationError("A bot token is required to enable Telegram");
  }
  const updated: Project = { ...project, telegram, updatedAt: nextUpdatedAt(project.updatedAt) };
  await updateProject(repo, updated, project.updatedAt);
  return { project: updated, view: maskedView(cipher, updated) };
}

/**
 * Forget the bot. Telegram is told first, best effort: a webhook left
 * registered keeps Telegram delivering to an endpoint that now answers 404,
 * and Telegram retries those for a day. A failure there is logged and the
 * credentials are dropped regardless — a stale registration is Telegram's
 * problem to give up on, a stored token nobody wants is ours.
 */
export async function disconnectProjectTelegram(
  repo: ProjectRepository,
  name: string,
  userEmail: string,
  cipher: SecretCipher,
  deleteWebhook: (botToken: string) => Promise<void>,
): Promise<ProjectTelegramResult> {
  const project = await assertProjectWritable(repo, name, userEmail);
  const runtime = resolveProjectTelegramCredentials(cipher, project);
  if (runtime) {
    await deleteWebhook(runtime.botToken).catch((error) =>
      log.warn("telegram", `could not delete the webhook for ${name}; Telegram will give up on its own`, error),
    );
  }
  const updated: Project = {
    ...project,
    telegram: undefined,
    updatedAt: nextUpdatedAt(project.updatedAt),
  };
  await updateProject(repo, updated, project.updatedAt);
  return { project: updated, view: maskedView(cipher, updated) };
}

/** Decrypted credentials, whether or not the bot is enabled. Only call at dispatch time. */
function resolveProjectTelegramCredentials(
  cipher: SecretCipher,
  project: Project,
): { botToken: string; webhookSecret: string; botUsername?: string } | null {
  const telegram = project.telegram;
  if (!telegram?.botToken || !telegram.webhookSecret) {
    return null;
  }
  return {
    botToken: cipher.decrypt(telegram.botToken),
    webhookSecret: cipher.decrypt(telegram.webhookSecret),
    ...(telegram.botUsername ? { botUsername: telegram.botUsername } : {}),
  };
}

/** Decrypt credentials for runtime use, for an enabled bot. Only call at dispatch time. */
export function resolveProjectTelegramRuntime(
  cipher: SecretCipher,
  project: Project,
): { botToken: string; webhookSecret: string; botUsername?: string } | null {
  if (!project.telegram?.enabled) {
    return null;
  }
  return resolveProjectTelegramCredentials(cipher, project);
}

/**
 * Verify a project's stored bot token against Telegram. Owner-gated by the
 * caller; `getMe` is injected so this stays free of the Telegram HTTP client.
 */
export async function testProjectTelegram(
  repo: ProjectRepository,
  name: string,
  userEmail: string,
  cipher: SecretCipher,
  getMe: (botToken: string) => Promise<TelegramBotIdentity>,
): Promise<{ ok: true; botId: number; botUsername?: string } | { ok: false }> {
  const project = await assertProjectWritable(repo, name, userEmail);
  const runtime = resolveProjectTelegramRuntime(cipher, project);
  if (!runtime) {
    return { ok: false };
  }
  const identity = await getMe(runtime.botToken);
  return { ok: true, botId: identity.id, ...(identity.username ? { botUsername: identity.username } : {}) };
}

/**
 * Point the bot at this deployment. Telegram keeps exactly one webhook per bot,
 * so calling this again simply moves it — which is what a redeploy under a new
 * public URL needs.
 */
export async function registerProjectTelegramWebhook(
  repo: ProjectRepository,
  name: string,
  userEmail: string,
  cipher: SecretCipher,
  baseUrl: string,
  setWebhook: (
    botToken: string,
    args: { url: string; secretToken: string; allowedUpdates: readonly string[] },
  ) => Promise<void>,
): Promise<{ ok: true; url: string } | { ok: false }> {
  const project = await assertProjectWritable(repo, name, userEmail);
  const runtime = resolveProjectTelegramRuntime(cipher, project);
  if (!runtime) {
    return { ok: false };
  }
  const url = `${baseUrl}${webhookPathFor(project.name)}`;
  await setWebhook(runtime.botToken, {
    url,
    secretToken: runtime.webhookSecret,
    allowedUpdates: ALLOWED_UPDATES,
  });
  return { ok: true, url };
}

/**
 * What one Telegram update on this project's endpoint needs before it can be
 * handled: the secret to check it with, the token to answer with, and the
 * username that tells a mention of this bot from anyone else's. Null when the
 * project is missing or its bot is not enabled. No session is involved — the
 * secret is the authentication.
 */
export interface TelegramEventBinding {
  projectName: string;
  botToken: string;
  webhookSecret: string;
  botUsername?: string;
}

export async function resolveTelegramEventBinding(
  repo: ProjectRepository,
  projectName: string,
  cipher: SecretCipher,
): Promise<TelegramEventBinding | null> {
  const project = await repo.get(projectName);
  const runtime = project ? resolveProjectTelegramRuntime(cipher, project) : null;
  if (!project || !runtime) {
    return null;
  }
  return { projectName: project.name, ...runtime };
}

/**
 * The project-Telegram surface bound to its repository, cipher and the three
 * Bot API calls it makes, composed once by the composition root. A route takes
 * the bound object; the events endpoint takes `resolveEventBinding`.
 */
export interface ProjectTelegramUseCases {
  get(name: string, userEmail: string): Promise<ProjectTelegramResult>;
  update(name: string, update: ProjectTelegramUpdate, userEmail: string): Promise<ProjectTelegramResult>;
  disconnect(name: string, userEmail: string): Promise<ProjectTelegramResult>;
  test(
    name: string,
    userEmail: string,
  ): Promise<{ ok: true; botId: number; botUsername?: string } | { ok: false }>;
  registerWebhook(name: string, userEmail: string, baseUrl: string): Promise<{ ok: true; url: string } | { ok: false }>;
  /** No session involved — the request's secret token is the authentication. */
  resolveEventBinding(projectName: string): Promise<TelegramEventBinding | null>;
}

export function createProjectTelegramUseCases(deps: {
  projects: ProjectRepository;
  cipher: SecretCipher;
  getMe: (botToken: string) => Promise<TelegramBotIdentity>;
  setWebhook: (
    botToken: string,
    args: { url: string; secretToken: string; allowedUpdates: readonly string[] },
  ) => Promise<void>;
  deleteWebhook: (botToken: string) => Promise<void>;
}): ProjectTelegramUseCases {
  return {
    get: (name, userEmail) => getProjectTelegram(deps.projects, name, userEmail, deps.cipher),
    update: (name, update, userEmail) =>
      updateProjectTelegram(deps.projects, name, update, userEmail, deps.cipher, deps.getMe),
    disconnect: (name, userEmail) =>
      disconnectProjectTelegram(deps.projects, name, userEmail, deps.cipher, deps.deleteWebhook),
    test: (name, userEmail) =>
      testProjectTelegram(deps.projects, name, userEmail, deps.cipher, deps.getMe),
    registerWebhook: (name, userEmail, baseUrl) =>
      registerProjectTelegramWebhook(deps.projects, name, userEmail, deps.cipher, baseUrl, deps.setWebhook),
    resolveEventBinding: (projectName) =>
      resolveTelegramEventBinding(deps.projects, projectName, deps.cipher),
  };
}
