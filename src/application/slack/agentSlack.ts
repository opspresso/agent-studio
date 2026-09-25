import { ValidationError } from "@/application/errors";
import { MCP_OAUTH_CALLBACK_PATH } from "@/application/mcp/mcpAuthUseCases";
import { persistAgentUpdate } from "@/application/agent/agentUpdate";
import { assertAgentOwnerOrAdminReadable, assertAgentWritable } from "@/application/agent/agentUseCases";
import type { SecretCipher } from "@/domain/security/secretCipher";
import type { Agent, SlackIntegration } from "@/domain/agent/types";
import type { AgentRepository } from "@/domain/agent/repository";
import type { SlackChannelInfo, SlackSuggestedPrompt } from "@/domain/slack/types";
import {
  MAX_AGENT_DESCRIPTION_LENGTH,
  MAX_APP_DESCRIPTION_LENGTH,
  MAX_CHANNEL_KEYWORDS,
  MAX_KEYWORD_LENGTH,
  MAX_PROMPT_MESSAGE_LENGTH,
  MAX_PROMPT_TITLE_LENGTH,
  MAX_SUGGESTED_PROMPTS,
  MIN_KEYWORD_LENGTH,
} from "@/domain/slack/types";
import { nextUpdatedAt } from "@/shared/nextUpdatedAt";
import { DEFAULT_SERVICE_NAME } from "@/shared/branding";
import { slackSecretContext } from "@/domain/security/secretContext";

export interface AgentSlackView {
  enabled: boolean;
  configured: boolean;
  botToken: string;
  signingSecret: string;
  eventsPath: string;
  /** Not a secret, unlike the two above — returned as stored. */
  suggestedPrompts: SlackSuggestedPrompt[];
  /** Not a secret either. Empty means mentions and follow-ups only. */
  channelKeywords: string[];
}

export interface AgentSlackUpdate {
  botToken?: string;
  signingSecret?: string;
  enabled?: boolean;
  suggestedPrompts?: SlackSuggestedPrompt[];
  channelKeywords?: string[];
}

export function eventsPathFor(agentName: string): string {
  return `/api/slack/events/${agentName}`;
}

function maskedView(cipher: SecretCipher, agent: Agent): AgentSlackView {
  const slack = agent.slack;
  return {
    enabled: slack?.enabled ?? false,
    configured: Boolean(slack?.botToken && slack.signingSecret),
    botToken: slack?.botToken
      ? cipher.mask(slack.botToken, slackSecretContext(agent.name, "bot-token"))
      : "",
    signingSecret: slack?.signingSecret
      ? cipher.mask(slack.signingSecret, slackSecretContext(agent.name, "signing-secret"))
      : "",
    eventsPath: eventsPathFor(agent.name),
    suggestedPrompts: slack?.suggestedPrompts ?? [],
    channelKeywords: slack?.channelKeywords ?? [],
  };
}

/**
 * Normalize the keyword list the editor sends: drop blanks, fold case, and
 * remove duplicates.
 *
 * Case is folded at rest rather than at match time because the list is shown
 * back to the operator — storing `Deploy` and `deploy` as two entries would
 * display a list with a distinction the matcher does not make.
 */
function cleanKeywords(input: string[]): string[] {
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const raw of input) {
    const keyword = raw.trim().toLowerCase();
    if (keyword === "" || seen.has(keyword)) {
      continue;
    }
    if (keyword.length < MIN_KEYWORD_LENGTH) {
      throw new ValidationError(
        `A channel keyword needs at least ${MIN_KEYWORD_LENGTH} characters`,
      );
    }
    if (keyword.length > MAX_KEYWORD_LENGTH) {
      throw new ValidationError(
        `A channel keyword is limited to ${MAX_KEYWORD_LENGTH} characters`,
      );
    }
    seen.add(keyword);
    keywords.push(keyword);
  }
  if (keywords.length > MAX_CHANNEL_KEYWORDS) {
    throw new ValidationError(`At most ${MAX_CHANNEL_KEYWORDS} channel keywords are allowed`);
  }
  return keywords;
}

/**
 * Reject a prompt list Slack would reject, and drop the empty rows the editor
 * leaves behind — an editor with four blank slots must not store four prompts.
 */
function cleanPrompts(input: SlackSuggestedPrompt[]): SlackSuggestedPrompt[] {
  const prompts = input
    .map((prompt) => ({ title: prompt.title.trim(), message: prompt.message.trim() }))
    .filter((prompt) => prompt.title !== "" || prompt.message !== "");
  if (prompts.length > MAX_SUGGESTED_PROMPTS) {
    throw new ValidationError(`Slack accepts at most ${MAX_SUGGESTED_PROMPTS} suggested prompts`);
  }
  for (const prompt of prompts) {
    if (!prompt.title || !prompt.message) {
      throw new ValidationError("A suggested prompt needs both a title and a message");
    }
    if (prompt.title.length > MAX_PROMPT_TITLE_LENGTH) {
      throw new ValidationError(
        `A suggested prompt title is limited to ${MAX_PROMPT_TITLE_LENGTH} characters`,
      );
    }
    if (prompt.message.length > MAX_PROMPT_MESSAGE_LENGTH) {
      throw new ValidationError(
        `A suggested prompt message is limited to ${MAX_PROMPT_MESSAGE_LENGTH} characters`,
      );
    }
  }
  return prompts;
}

/**
 * The masked view plus the agent it was built from, as it stands *after* the
 * call. Callers render more than the view — the Slack app manifest is derived
 * from the agent — and a mutation handing back the pre-write agent would
 * describe the configuration it just replaced.
 */
export interface AgentSlackResult {
  agent: Agent;
  view: AgentSlackView;
}

/**
 * Owner or admin, unlike the shared agent catalog: this exposes the masked bot
 * token and signing secret. Checked here rather than at the route so no verb can
 * be added without it, and so one read answers both the check and the view.
 */
export async function getAgentSlack(
  repo: AgentRepository,
  name: string,
  userEmail: string,
  cipher: SecretCipher,
): Promise<AgentSlackResult> {
  const agent = await assertAgentOwnerOrAdminReadable(repo, name, userEmail);
  return { agent, view: maskedView(cipher, agent) };
}

/** Merge semantics: masked/empty input keeps the stored secret; plaintext replaces it. */
function mergeSecret(
  cipher: SecretCipher,
  stored: string | undefined,
  input: string | undefined,
  context: string,
): string {
  if (input === undefined || cipher.isMasked(input) || input === "") {
    return stored ?? "";
  }
  return cipher.encrypt(input, context);
}

export async function updateAgentSlack(
  repo: AgentRepository,
  name: string,
  update: AgentSlackUpdate,
  userEmail: string,
  cipher: SecretCipher,
): Promise<AgentSlackResult> {
  const agent = await assertAgentWritable(repo, name, userEmail);
  const prompts =
    update.suggestedPrompts !== undefined
      ? cleanPrompts(update.suggestedPrompts)
      : (agent.slack?.suggestedPrompts ?? []);
  const keywords =
    update.channelKeywords !== undefined
      ? cleanKeywords(update.channelKeywords)
      : (agent.slack?.channelKeywords ?? []);
  const slack: SlackIntegration = {
    botToken: mergeSecret(
      cipher,
      agent.slack?.botToken,
      update.botToken,
      slackSecretContext(name, "bot-token"),
    ),
    signingSecret: mergeSecret(
      cipher,
      agent.slack?.signingSecret,
      update.signingSecret,
      slackSecretContext(name, "signing-secret"),
    ),
    enabled: update.enabled ?? agent.slack?.enabled ?? false,
    ...(prompts.length > 0 ? { suggestedPrompts: prompts } : {}),
    ...(keywords.length > 0 ? { channelKeywords: keywords } : {}),
  };
  if (slack.enabled && (!slack.botToken || !slack.signingSecret)) {
    throw new ValidationError("Bot token and signing secret are required to enable Slack");
  }
  const updated: Agent = { ...agent, slack, updatedAt: nextUpdatedAt(agent.updatedAt) };
  await persistAgentUpdate(repo, updated, agent.updatedAt);
  return { agent: updated, view: maskedView(cipher, updated) };
}

export async function disconnectAgentSlack(
  repo: AgentRepository,
  name: string,
  userEmail: string,
  cipher: SecretCipher,
): Promise<AgentSlackResult> {
  const agent = await assertAgentWritable(repo, name, userEmail);
  const updated: Agent = {
    ...agent,
    slack: undefined,
    updatedAt: nextUpdatedAt(agent.updatedAt),
  };
  await persistAgentUpdate(repo, updated, agent.updatedAt);
  return { agent: updated, view: maskedView(cipher, updated) };
}

/** Decrypt credentials for runtime use. Only call at dispatch time. */
export function resolveAgentSlackRuntime(
  cipher: SecretCipher,
  agent: Agent,
): { botToken: string; signingSecret: string } | null {
  const slack = agent.slack;
  if (!slack?.enabled || !slack.botToken || !slack.signingSecret) {
    return null;
  }
  return {
    botToken: cipher.decrypt(slack.botToken, slackSecretContext(agent.name, "bot-token")),
    signingSecret: cipher.decrypt(
      slack.signingSecret,
      slackSecretContext(agent.name, "signing-secret"),
    ),
  };
}

function defaultAgentDescription(agent: Agent, serviceName: string): string {
  return `${serviceName} bot for the ${agent.name} agent`;
}

/** Slack app manifest for this agent's dedicated bot. */
export function buildAgentSlackManifest(
  agent: Agent,
  baseUrl: string,
  serviceName = DEFAULT_SERVICE_NAME,
): Record<string, unknown> {
  const description = agent.description.trim() || defaultAgentDescription(agent, serviceName);
  return {
    display_information: {
      name: agent.displayName.slice(0, 35),
      description: description.slice(0, MAX_APP_DESCRIPTION_LENGTH),
      background_color: "#2b5cd9",
    },
    features: {
      app_home: {
        // Only the Messages tab is rendered; no Home view is published.
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: { display_name: agent.displayName.slice(0, 80), always_online: true },
      // The agent messaging experience. `agent_description` is required once
      // this key is present, and it is the only text a user sees before asking
      // anything — an empty view reads as a bot that is not running.
      agent_view: {
        agent_description: description.slice(0, MAX_AGENT_DESCRIPTION_LENGTH),
        suggested_prompts: (agent.slack?.suggestedPrompts ?? []).slice(0, MAX_SUGGESTED_PROMPTS),
      },
    },
    oauth_config: {
      redirect_urls: [`${baseUrl}${MCP_OAUTH_CALLBACK_PATH}`],
      scopes: {
        bot: [
          "app_mentions:read",
          "assistant:write",
          "channels:history",
          "channels:read",
          "chat:write",
          "files:read",
          "files:write",
          "groups:history",
          "groups:read",
          "im:history",
          "im:write",
          "reactions:read",
          "reactions:write",
          "users:read.email",
          "users:read",
        ],
      },
      pkce_enabled: false,
    },
    settings: {
      event_subscriptions: {
        request_url: `${baseUrl}${eventsPathFor(agent.name)}`,
        // `app_home_opened` is how the agent messaging experience announces a
        // user opening the container — without it the panel opens with no
        // prompts. `app_context_changed` is deliberately absent: acting on the
        // channel a user is looking at needs per-user context storage, which
        // does not exist yet, and subscribing to an event nobody reads only
        // buys traffic.
        //
        // `message.channels`/`message.groups` are what let a follow-up in a
        // thread the bot answered in skip the mention. They deliver every
        // message in every channel the bot belongs to — not the workspace, but
        // still far more than is for it — which is why `classifySlackEvent`
        // decides ahead of the dedup claim. Both eras of channel are
        // subscribed together on purpose: `groups:history` is already granted,
        // and taking only the public half would leave follow-ups silently
        // broken in private channels with nothing saying why.
        bot_events: [
          "app_mention",
          "app_home_opened",
          "agent_session_stopped",
          "message.channels",
          "message.groups",
          "message.im",
        ],
      },
      // The event endpoint accepts JSON events, not interactive form payloads.
      interactivity: { is_enabled: false },
      // Org deployment is managed in Slack; retain an existing true value when reapplying.
      socket_mode_enabled: false,
      token_rotation_enabled: false,
      is_mcp_enabled: true,
    },
  };
}

/**
 * Verify an agent's stored bot token against Slack. Owner-gated by the caller;
 * `authTest` is injected so this stays free of the Slack HTTP client.
 */
export async function testAgentSlack(
  repo: AgentRepository,
  name: string,
  userEmail: string,
  cipher: SecretCipher,
  authTest: (botToken: string) => Promise<{ team?: string; user?: string }>,
): Promise<{ ok: true; team?: string; botUser?: string } | { ok: false }> {
  const agent = await assertAgentOwnerOrAdminReadable(repo, name, userEmail);
  const runtime = resolveAgentSlackRuntime(cipher, agent);
  if (!runtime) {
    return { ok: false };
  }
  const identity = await authTest(runtime.botToken);
  return { ok: true, team: identity.team, botUser: identity.user };
}

/**
 * What one Slack event on this agent's endpoint needs before it can be
 * handled: the credentials to verify it with, and the policy that decides
 * whether it is for this bot at all. Null when the agent is missing or its
 * bot is not enabled. No session is involved — the signature is the
 * authentication.
 *
 * The keywords ride along rather than being fetched by the gate: this read
 * already happens on every delivered event, and a second one to ask what the
 * agent listens for would double the cost of ignoring a message.
 */
export interface SlackEventBinding {
  agentName: string;
  botToken: string;
  signingSecret: string;
  channelKeywords: string[];
}

export async function resolveSlackEventBinding(
  repo: AgentRepository,
  agentName: string,
  cipher: SecretCipher,
): Promise<SlackEventBinding | null> {
  const agent = await repo.get(agentName);
  const runtime = agent ? resolveAgentSlackRuntime(cipher, agent) : null;
  if (!agent || !runtime) {
    return null;
  }
  return {
    agentName: agent.name,
    ...runtime,
    channelKeywords: agent.slack?.channelKeywords ?? [],
  };
}

/**
 * The agent-Slack surface bound to its repository and cipher, composed once
 * by the composition root. Same split as {@link createAgentUseCases}: a route
 * takes the bound object, an application module that already holds the
 * repository calls the function.
 *
 * `authTest` is bound here too. It is the Slack HTTP client, deferred by the
 * composition root so a route that wanted an agent did not load it — and a
 * route choosing which client verifies a token is the same defect as a route
 * choosing which cipher decrypts one.
 */
export interface AgentSlackUseCases {
  get(name: string, userEmail: string): Promise<AgentSlackResult>;
  update(name: string, update: AgentSlackUpdate, userEmail: string): Promise<AgentSlackResult>;
  disconnect(name: string, userEmail: string): Promise<AgentSlackResult>;
  test(name: string, userEmail: string): Promise<{ ok: true; team?: string; botUser?: string } | { ok: false }>;
  channels(name: string, userEmail: string): Promise<SlackChannelInfo[]>;
  /** No session involved — the request signature is the authentication. */
  resolveEventBinding(agentName: string): Promise<SlackEventBinding | null>;
}

export function createAgentSlackUseCases(deps: {
  agents: AgentRepository;
  cipher: SecretCipher;
  authTest: (botToken: string) => Promise<{ team?: string; user?: string }>;
  listChannels: (botToken: string) => Promise<SlackChannelInfo[]>;
}): AgentSlackUseCases {
  return {
    get: (name, userEmail) => getAgentSlack(deps.agents, name, userEmail, deps.cipher),
    update: (name, update, userEmail) =>
      updateAgentSlack(deps.agents, name, update, userEmail, deps.cipher),
    disconnect: (name, userEmail) =>
      disconnectAgentSlack(deps.agents, name, userEmail, deps.cipher),
    test: (name, userEmail) =>
      testAgentSlack(deps.agents, name, userEmail, deps.cipher, deps.authTest),
    channels: async (name, userEmail) => {
      const agent = await assertAgentOwnerOrAdminReadable(deps.agents, name, userEmail);
      const runtime = resolveAgentSlackRuntime(deps.cipher, agent);
      if (!runtime) {
        throw new ValidationError("Slack is not configured or not enabled for this agent");
      }
      return (await deps.listChannels(runtime.botToken))
        .filter((channel) => channel.isMember === true)
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    resolveEventBinding: (agentName) =>
      resolveSlackEventBinding(deps.agents, agentName, deps.cipher),
  };
}
