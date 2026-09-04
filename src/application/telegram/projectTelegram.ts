import { ValidationError } from "@/application/errors";
import { persistProjectUpdate } from "@/application/project/projectUpdate";
import { assertProjectWritable } from "@/application/project/projectUseCases";
import { nextUpdatedAt } from "@/application/project/timestamps";
import { botIdFromToken } from "@/application/telegram/engagement";
import type { SecretCipher } from "@/domain/security/secretCipher";
import type { Project, TelegramIntegration } from "@/domain/project/types";
import type { ProjectRepository } from "@/domain/project/repository";
import type {
  TelegramDestination,
  TelegramDestinationRepository,
} from "@/domain/telegram/destination";
import { generateSecretValue } from "@/shared/generatedSecret";
import { log } from "@/shared/logger";
import { telegramSecretContext } from "@/domain/security/secretContext";

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

/** Observed chats the settings surface may render in one bounded selector. */
export const MAX_TELEGRAM_DESTINATIONS = 100;

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
    botToken: telegram?.botToken
      ? cipher.mask(telegram.botToken, telegramSecretContext(project.name, "bot-token"))
      : "",
    botUsername: telegram?.botUsername ?? "",
    webhookPath: webhookPathFor(project.name),
  };
}

export interface ProjectTelegramResult {
  project: Project;
  view: ProjectTelegramView;
  /** What the save could not do on Telegram's side, when anything. */
  warnings?: string[];
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

/** Destinations observed by the currently configured bot, newest first. */
export async function listProjectTelegramDestinations(
  repo: ProjectRepository,
  destinations: TelegramDestinationRepository,
  name: string,
  userEmail: string,
  cipher: SecretCipher,
): Promise<TelegramDestination[]> {
  const project = await assertProjectWritable(repo, name, userEmail);
  const runtime = resolveProjectTelegramCredentials(cipher, project);
  const botId = runtime ? botIdFromToken(runtime.botToken) : undefined;
  return botId === undefined
    ? []
    : destinations.list(project.name, botId, MAX_TELEGRAM_DESTINATIONS);
}

/** The three Bot API calls the settings slice makes; injected so it stays free of the HTTP client. */
export interface TelegramWebhookCalls {
  getMe: (botToken: string) => Promise<TelegramBotIdentity>;
  setWebhook: (
    botToken: string,
    args: { url: string; secretToken: string; allowedUpdates: readonly string[] },
  ) => Promise<void>;
  deleteWebhook: (botToken: string) => Promise<void>;
}

/**
 * Save a token, or turn the bot on or off — and keep Telegram's idea of the
 * webhook in step with it.
 *
 * A *new* token is checked with Telegram before it is stored — `getMe` is the
 * one call that costs nothing and says both whether the token is real and what
 * the bot is called, and the username is what a group mention is matched
 * against later. A masked or empty token keeps what is stored (a mask can only
 * confirm a secret, never create one).
 *
 * The webhook follows the switch, because a webhook that does not is a bot
 * that keeps talking after it was turned off. Enabling registers the webhook
 * at this deployment; disabling deletes it, so Telegram stops delivering and
 * holding updates for a bot nobody is answering — otherwise every message to a
 * disabled bot is retried against a 404 for a day and delivered, late and
 * billed, the moment the box is ticked again. Replacing the token retires the
 * old bot's webhook, mints a fresh secret so a delivery from the old bot no
 * longer verifies even where that delete failed, and registers the new bot when
 * the switch is on. Every Telegram call but `getMe` is best effort: the
 * credentials are the operator's decision and are stored regardless, and a
 * registration that failed is said so in the response rather than hidden.
 */
export async function updateProjectTelegram(
  repo: ProjectRepository,
  name: string,
  update: ProjectTelegramUpdate,
  userEmail: string,
  cipher: SecretCipher,
  calls: TelegramWebhookCalls,
  /** Where this deployment is reached; the webhook is registered under it. */
  baseUrl: string,
): Promise<ProjectTelegramResult> {
  const project = await assertProjectWritable(repo, name, userEmail);
  if (project.projectType !== "agent") {
    throw new ValidationError("Telegram bots can only be attached to agent projects");
  }
  const stored = project.telegram;
  const previous = resolveProjectTelegramCredentials(cipher, project);
  let botToken = stored?.botToken ?? "";
  let botUsername = stored?.botUsername;
  let webhookSecret =
    stored?.webhookSecret ??
    cipher.encrypt(
      generateSecretValue("telegramWebhookSecret"),
      telegramSecretContext(name, "webhook-secret"),
    );
  let tokenChanged = false;
  const incoming = update.botToken;
  if (incoming !== undefined && incoming !== "" && !cipher.isMasked(incoming)) {
    const token = incoming.trim();
    let identity: TelegramBotIdentity;
    try {
      identity = await calls.getMe(token);
    } catch (error) {
      throw new ValidationError(
        `Telegram did not accept the bot token: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
    tokenChanged = previous?.botToken !== token;
    botToken = cipher.encrypt(token, telegramSecretContext(name, "bot-token"));
    botUsername = identity.username;
    if (tokenChanged && previous) {
      // The old bot must stop delivering here, and must stop being able to:
      // its webhook goes, and so does the secret it was registered with.
      await calls
        .deleteWebhook(previous.botToken)
        .catch((error) => log.warn("telegram", `could not delete the previous bot's webhook for ${name}`, error));
      webhookSecret = cipher.encrypt(
        generateSecretValue("telegramWebhookSecret"),
        telegramSecretContext(name, "webhook-secret"),
      );
    }
  }
  const telegram: TelegramIntegration = {
    botToken,
    webhookSecret,
    enabled: update.enabled ?? stored?.enabled ?? false,
    ...(botUsername ? { botUsername } : {}),
  };
  if (telegram.enabled && !telegram.botToken) {
    throw new ValidationError("A bot token is required to enable Telegram");
  }
  const updated: Project = { ...project, telegram, updatedAt: nextUpdatedAt(project.updatedAt) };
  await persistProjectUpdate(repo, updated, project.updatedAt);

  const wasEnabled = stored?.enabled === true;
  const runtime = resolveProjectTelegramCredentials(cipher, updated);
  const warnings: string[] = [];
  if (runtime && telegram.enabled && (!wasEnabled || tokenChanged)) {
    await calls
      .setWebhook(runtime.botToken, {
        url: `${baseUrl}${webhookPathFor(name)}`,
        secretToken: runtime.webhookSecret,
        allowedUpdates: ALLOWED_UPDATES,
      })
      .catch((error) => {
        log.warn("telegram", `could not register the webhook for ${name}`, error);
        warnings.push(
          `Saved, but Telegram did not accept the webhook: ${error instanceof Error ? error.message : "unknown"}. Use Register webhook to try again.`,
        );
      });
  } else if (runtime && !telegram.enabled && wasEnabled) {
    await calls
      .deleteWebhook(runtime.botToken)
      .catch((error) => log.warn("telegram", `could not delete the webhook for ${name}; Telegram will give up on its own`, error));
  }
  return { project: updated, view: maskedView(cipher, updated), ...(warnings.length > 0 ? { warnings } : {}) };
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
  await persistProjectUpdate(repo, updated, project.updatedAt);
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
    botToken: cipher.decrypt(
      telegram.botToken,
      telegramSecretContext(project.name, "bot-token"),
    ),
    webhookSecret: cipher.decrypt(
      telegram.webhookSecret,
      telegramSecretContext(project.name, "webhook-secret"),
    ),
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
 * Retire a project's bot webhook, for the moment the project itself is deleted:
 * the token goes with the row, so this is the last chance to tell Telegram to
 * stop delivering to an address that will answer 404 forever. Best effort, and
 * nothing to do for a project without an enabled bot — a disabled one had its
 * webhook deleted when it was disabled.
 */
export async function revokeProjectTelegramWebhook(
  cipher: SecretCipher,
  project: Project,
  deleteWebhook: (botToken: string) => Promise<void>,
): Promise<void> {
  const runtime = resolveProjectTelegramRuntime(cipher, project);
  if (!runtime) {
    return;
  }
  await deleteWebhook(runtime.botToken).catch((error) =>
    log.warn("telegram", `could not delete the webhook for ${project.name} on delete`, error),
  );
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
  listDestinations(name: string, userEmail: string): Promise<TelegramDestination[]>;
  update(
    name: string,
    update: ProjectTelegramUpdate,
    userEmail: string,
    baseUrl: string,
  ): Promise<ProjectTelegramResult>;
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
  destinations: TelegramDestinationRepository;
  cipher: SecretCipher;
  getMe: (botToken: string) => Promise<TelegramBotIdentity>;
  setWebhook: (
    botToken: string,
    args: { url: string; secretToken: string; allowedUpdates: readonly string[] },
  ) => Promise<void>;
  deleteWebhook: (botToken: string) => Promise<void>;
}): ProjectTelegramUseCases {
  const calls: TelegramWebhookCalls = {
    getMe: deps.getMe,
    setWebhook: deps.setWebhook,
    deleteWebhook: deps.deleteWebhook,
  };
  return {
    get: (name, userEmail) => getProjectTelegram(deps.projects, name, userEmail, deps.cipher),
    listDestinations: (name, userEmail) =>
      listProjectTelegramDestinations(
        deps.projects,
        deps.destinations,
        name,
        userEmail,
        deps.cipher,
      ),
    update: (name, update, userEmail, baseUrl) =>
      updateProjectTelegram(deps.projects, name, update, userEmail, deps.cipher, calls, baseUrl),
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
