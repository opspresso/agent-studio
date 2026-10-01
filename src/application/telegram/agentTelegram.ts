import { ValidationError } from "@/application/errors";
import { persistAgentUpdate } from "@/application/agent/agentUpdate";
import { assertAgentOwnerOrAdminReadable, assertAgentWritable } from "@/application/agent/agentUseCases";
import { nextUpdatedAt } from "@/shared/nextUpdatedAt";
import { botIdFromToken } from "@/application/telegram/engagement";
import type { SecretCipher } from "@/domain/security/secretCipher";
import type { Agent, TelegramIntegration } from "@/domain/agent/types";
import type { AgentRepository } from "@/domain/agent/repository";
import type {
  TelegramDestination,
  TelegramDestinationRepository,
} from "@/domain/telegram/destination";
import { generateSecretValue } from "@/shared/generatedSecret";
import { log } from "@/shared/logger";
import { telegramSecretContext } from "@/domain/security/secretContext";

/**
 * An agent's Telegram bot: what the console reads and writes, and what the
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

export interface AgentTelegramView {
  enabled: boolean;
  configured: boolean;
  /** Masked. */
  botToken: string;
  /** Not a secret: the bot's `@username`, once a token has been checked. */
  botUsername: string;
  webhookPath: string;
}

export interface AgentTelegramUpdate {
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

export function webhookPathFor(agentName: string): string {
  return `/api/telegram/webhook/${agentName}`;
}

function maskedView(cipher: SecretCipher, agent: Agent): AgentTelegramView {
  const telegram = agent.telegram;
  return {
    enabled: telegram?.enabled ?? false,
    configured: Boolean(telegram?.botToken && telegram.webhookSecret),
    botToken: telegram?.botToken
      ? cipher.mask(telegram.botToken, telegramSecretContext(agent.name, "bot-token"))
      : "",
    botUsername: telegram?.botUsername ?? "",
    webhookPath: webhookPathFor(agent.name),
  };
}

export interface AgentTelegramResult {
  agent: Agent;
  view: AgentTelegramView;
  /** What the save could not do on Telegram's side, when anything. */
  warnings?: string[];
}

/**
 * Owner or admin, unlike the shared agent catalog: this exposes the masked
 * bot token. Checked here rather than at the route so no verb can be added
 * without it.
 */
export async function getAgentTelegram(
  repo: AgentRepository,
  name: string,
  userEmail: string,
  cipher: SecretCipher,
): Promise<AgentTelegramResult> {
  const agent = await assertAgentOwnerOrAdminReadable(repo, name, userEmail);
  return { agent, view: maskedView(cipher, agent) };
}

/** Destinations observed by the currently configured bot, newest first. */
export async function listAgentTelegramDestinations(
  repo: AgentRepository,
  destinations: TelegramDestinationRepository,
  name: string,
  userEmail: string,
  cipher: SecretCipher,
): Promise<TelegramDestination[]> {
  const agent = await assertAgentOwnerOrAdminReadable(repo, name, userEmail);
  const runtime = resolveAgentTelegramCredentials(cipher, agent);
  const botId = runtime ? botIdFromToken(runtime.botToken) : undefined;
  return botId === undefined
    ? []
    : destinations.list(agent.name, botId, MAX_TELEGRAM_DESTINATIONS);
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
export async function updateAgentTelegram(
  repo: AgentRepository,
  name: string,
  update: AgentTelegramUpdate,
  userEmail: string,
  cipher: SecretCipher,
  calls: TelegramWebhookCalls,
  /** Where this deployment is reached; the webhook is registered under it. */
  baseUrl: string,
): Promise<AgentTelegramResult> {
  const agent = await assertAgentWritable(repo, name, userEmail);
  const stored = agent.telegram;
  const previous = resolveAgentTelegramCredentials(cipher, agent);
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
  const updated: Agent = { ...agent, telegram, updatedAt: nextUpdatedAt(agent.updatedAt) };
  await persistAgentUpdate(repo, updated, agent.updatedAt);

  if (tokenChanged && previous) {
    await calls
      .deleteWebhook(previous.botToken)
      .catch((error) => log.warn("telegram", `could not delete the previous bot's webhook for ${name}`, error));
  }
  const wasEnabled = stored?.enabled === true;
  const runtime = resolveAgentTelegramCredentials(cipher, updated);
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
  return { agent: updated, view: maskedView(cipher, updated), ...(warnings.length > 0 ? { warnings } : {}) };
}

/**
 * Forget the bot, then notify Telegram best effort: a webhook left
 * registered keeps Telegram delivering to an endpoint that now answers 404,
 * and Telegram retries those for a day. A failure there is logged and the
 * credentials remain dropped — a stale registration is Telegram's
 * problem to give up on, a stored token nobody wants is ours.
 */
export async function disconnectAgentTelegram(
  repo: AgentRepository,
  name: string,
  userEmail: string,
  cipher: SecretCipher,
  deleteWebhook: (botToken: string) => Promise<void>,
): Promise<AgentTelegramResult> {
  const agent = await assertAgentWritable(repo, name, userEmail);
  const runtime = resolveAgentTelegramCredentials(cipher, agent);
  const updated: Agent = {
    ...agent,
    telegram: undefined,
    updatedAt: nextUpdatedAt(agent.updatedAt),
  };
  await persistAgentUpdate(repo, updated, agent.updatedAt);
  if (runtime) {
    await deleteWebhook(runtime.botToken).catch((error) =>
      log.warn("telegram", `could not delete the webhook for ${name}; Telegram will give up on its own`, error),
    );
  }
  return { agent: updated, view: maskedView(cipher, updated) };
}

/** Decrypted credentials, whether or not the bot is enabled. Only call at dispatch time. */
function resolveAgentTelegramCredentials(
  cipher: SecretCipher,
  agent: Agent,
): { botToken: string; webhookSecret: string; botUsername?: string } | null {
  const telegram = agent.telegram;
  if (!telegram?.botToken || !telegram.webhookSecret) {
    return null;
  }
  return {
    botToken: cipher.decrypt(
      telegram.botToken,
      telegramSecretContext(agent.name, "bot-token"),
    ),
    webhookSecret: cipher.decrypt(
      telegram.webhookSecret,
      telegramSecretContext(agent.name, "webhook-secret"),
    ),
    ...(telegram.botUsername ? { botUsername: telegram.botUsername } : {}),
  };
}

/** Decrypt credentials for runtime use, for an enabled bot. Only call at dispatch time. */
export function resolveAgentTelegramRuntime(
  cipher: SecretCipher,
  agent: Agent,
): { botToken: string; webhookSecret: string; botUsername?: string } | null {
  if (!agent.telegram?.enabled) {
    return null;
  }
  return resolveAgentTelegramCredentials(cipher, agent);
}

/**
 * Verify an agent's stored bot token against Telegram. Owner-gated by the
 * caller; `getMe` is injected so this stays free of the Telegram HTTP client.
 */
export async function testAgentTelegram(
  repo: AgentRepository,
  name: string,
  userEmail: string,
  cipher: SecretCipher,
  getMe: (botToken: string) => Promise<TelegramBotIdentity>,
): Promise<{ ok: true; botId: number; botUsername?: string } | { ok: false }> {
  const agent = await assertAgentOwnerOrAdminReadable(repo, name, userEmail);
  const runtime = resolveAgentTelegramRuntime(cipher, agent);
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
export async function registerAgentTelegramWebhook(
  repo: AgentRepository,
  name: string,
  userEmail: string,
  cipher: SecretCipher,
  baseUrl: string,
  setWebhook: (
    botToken: string,
    args: { url: string; secretToken: string; allowedUpdates: readonly string[] },
  ) => Promise<void>,
): Promise<{ ok: true; url: string } | { ok: false }> {
  const agent = await assertAgentWritable(repo, name, userEmail);
  const runtime = resolveAgentTelegramRuntime(cipher, agent);
  if (!runtime) {
    return { ok: false };
  }
  const url = `${baseUrl}${webhookPathFor(agent.name)}`;
  await setWebhook(runtime.botToken, {
    url,
    secretToken: runtime.webhookSecret,
    allowedUpdates: ALLOWED_UPDATES,
  });
  return { ok: true, url };
}

/**
 * Retire an agent's bot webhook, for the moment the agent itself is deleted:
 * the token goes with the row, so this is the last chance to tell Telegram to
 * stop delivering to an address that will answer 404 forever. Best effort, and
 * nothing to do for an agent without an enabled bot — a disabled one had its
 * webhook deleted when it was disabled.
 */
export async function revokeAgentTelegramWebhook(
  cipher: SecretCipher,
  agent: Agent,
  deleteWebhook: (botToken: string) => Promise<void>,
): Promise<void> {
  const runtime = resolveAgentTelegramRuntime(cipher, agent);
  if (!runtime) {
    return;
  }
  await deleteWebhook(runtime.botToken).catch((error) =>
    log.warn("telegram", `could not delete the webhook for ${agent.name} on delete`, error),
  );
}

/**
 * What one Telegram update on this agent's endpoint needs before it can be
 * handled: the secret to check it with, the token to answer with, and the
 * username that tells a mention of this bot from anyone else's. Null when the
 * agent is missing or its bot is not enabled. No session is involved — the
 * secret is the authentication.
 */
export interface TelegramEventBinding {
  agentName: string;
  botToken: string;
  webhookSecret: string;
  botUsername?: string;
}

export async function resolveTelegramEventBinding(
  repo: AgentRepository,
  agentName: string,
  cipher: SecretCipher,
): Promise<TelegramEventBinding | null> {
  const agent = await repo.get(agentName);
  const runtime = agent ? resolveAgentTelegramRuntime(cipher, agent) : null;
  if (!agent || !runtime) {
    return null;
  }
  return { agentName: agent.name, ...runtime };
}

/**
 * The agent-Telegram surface bound to its repository, cipher and the three
 * Bot API calls it makes, composed once by the composition root. A route takes
 * the bound object; the events endpoint takes `resolveEventBinding`.
 */
export interface AgentTelegramUseCases {
  get(name: string, userEmail: string): Promise<AgentTelegramResult>;
  listDestinations(name: string, userEmail: string): Promise<TelegramDestination[]>;
  update(
    name: string,
    update: AgentTelegramUpdate,
    userEmail: string,
    baseUrl: string,
  ): Promise<AgentTelegramResult>;
  disconnect(name: string, userEmail: string): Promise<AgentTelegramResult>;
  test(
    name: string,
    userEmail: string,
  ): Promise<{ ok: true; botId: number; botUsername?: string } | { ok: false }>;
  registerWebhook(name: string, userEmail: string, baseUrl: string): Promise<{ ok: true; url: string } | { ok: false }>;
  /** No session involved — the request's secret token is the authentication. */
  resolveEventBinding(agentName: string): Promise<TelegramEventBinding | null>;
}

export function createAgentTelegramUseCases(deps: {
  agents: AgentRepository;
  destinations: TelegramDestinationRepository;
  cipher: SecretCipher;
  getMe: (botToken: string) => Promise<TelegramBotIdentity>;
  setWebhook: (
    botToken: string,
    args: { url: string; secretToken: string; allowedUpdates: readonly string[] },
  ) => Promise<void>;
  deleteWebhook: (botToken: string) => Promise<void>;
}): AgentTelegramUseCases {
  const calls: TelegramWebhookCalls = {
    getMe: deps.getMe,
    setWebhook: deps.setWebhook,
    deleteWebhook: deps.deleteWebhook,
  };
  return {
    get: (name, userEmail) => getAgentTelegram(deps.agents, name, userEmail, deps.cipher),
    listDestinations: (name, userEmail) =>
      listAgentTelegramDestinations(
        deps.agents,
        deps.destinations,
        name,
        userEmail,
        deps.cipher,
      ),
    update: (name, update, userEmail, baseUrl) =>
      updateAgentTelegram(deps.agents, name, update, userEmail, deps.cipher, calls, baseUrl),
    disconnect: (name, userEmail) =>
      disconnectAgentTelegram(deps.agents, name, userEmail, deps.cipher, deps.deleteWebhook),
    test: (name, userEmail) =>
      testAgentTelegram(deps.agents, name, userEmail, deps.cipher, deps.getMe),
    registerWebhook: (name, userEmail, baseUrl) =>
      registerAgentTelegramWebhook(deps.agents, name, userEmail, deps.cipher, baseUrl, deps.setWebhook),
    resolveEventBinding: (agentName) =>
      resolveTelegramEventBinding(deps.agents, agentName, deps.cipher),
  };
}
