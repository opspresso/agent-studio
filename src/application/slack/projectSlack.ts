import { ConflictError, ValidationError, isConditionalWriteFailure } from "@/application/errors";
import { MCP_OAUTH_CALLBACK_PATH } from "@/application/mcp/mcpAuthUseCases";
import { assertProjectWritable, getProject } from "@/application/project/projectUseCases";
import type { SecretCipher } from "@/domain/security/secretCipher";
import type { Project, SlackIntegration } from "@/domain/project/types";
import type { ProjectRepository } from "@/domain/project/repository";
import type { SlackSuggestedPrompt } from "@/domain/slack/types";
import {
  MAX_AGENT_DESCRIPTION_LENGTH,
  MAX_CHANNEL_KEYWORDS,
  MAX_KEYWORD_LENGTH,
  MAX_PROMPT_MESSAGE_LENGTH,
  MAX_PROMPT_TITLE_LENGTH,
  MAX_SUGGESTED_PROMPTS,
  MIN_KEYWORD_LENGTH,
} from "@/domain/slack/types";
import { nextUpdatedAt } from "@/application/project/timestamps";

export interface ProjectSlackView {
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

export interface ProjectSlackUpdate {
  botToken?: string;
  signingSecret?: string;
  enabled?: boolean;
  suggestedPrompts?: SlackSuggestedPrompt[];
  channelKeywords?: string[];
}

export function eventsPathFor(projectName: string): string {
  return `/api/slack/events/${projectName}`;
}

function maskedView(cipher: SecretCipher, project: Project): ProjectSlackView {
  const slack = project.slack;
  return {
    enabled: slack?.enabled ?? false,
    configured: Boolean(slack?.botToken && slack.signingSecret),
    botToken: slack?.botToken ? cipher.mask(slack.botToken) : "",
    signingSecret: slack?.signingSecret ? cipher.mask(slack.signingSecret) : "",
    eventsPath: eventsPathFor(project.name),
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
 * The masked view plus the project it was built from, as it stands *after* the
 * call. Callers render more than the view — the Slack app manifest is derived
 * from the project — and a mutation handing back the pre-write project would
 * describe the configuration it just replaced.
 */
export interface ProjectSlackResult {
  project: Project;
  view: ProjectSlackView;
}

/**
 * Owner or admin, unlike the shared project catalog: this exposes the masked bot
 * token and signing secret. Checked here rather than at the route so no verb can
 * be added without it, and so one read answers both the check and the view.
 */
export async function getProjectSlack(
  repo: ProjectRepository,
  name: string,
  userEmail: string,
  cipher: SecretCipher,
): Promise<ProjectSlackResult> {
  const project = await assertProjectWritable(repo, name, userEmail);
  return { project, view: maskedView(cipher, project) };
}

/** Merge semantics: masked/empty input keeps the stored secret; plaintext replaces it. */
function mergeSecret(
  cipher: SecretCipher,
  stored: string | undefined,
  input: string | undefined,
): string {
  if (input === undefined || cipher.isMasked(input) || input === "") {
    return stored ?? "";
  }
  return cipher.encrypt(input);
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

export async function updateProjectSlack(
  repo: ProjectRepository,
  name: string,
  update: ProjectSlackUpdate,
  userEmail: string,
  cipher: SecretCipher,
): Promise<ProjectSlackResult> {
  const project = await assertProjectWritable(repo, name, userEmail);
  if (project.projectType !== "agent") {
    throw new ValidationError("Slack bots can only be attached to agent projects");
  }
  const prompts =
    update.suggestedPrompts !== undefined
      ? cleanPrompts(update.suggestedPrompts)
      : (project.slack?.suggestedPrompts ?? []);
  const keywords =
    update.channelKeywords !== undefined
      ? cleanKeywords(update.channelKeywords)
      : (project.slack?.channelKeywords ?? []);
  const slack: SlackIntegration = {
    botToken: mergeSecret(cipher, project.slack?.botToken, update.botToken),
    signingSecret: mergeSecret(cipher, project.slack?.signingSecret, update.signingSecret),
    enabled: update.enabled ?? project.slack?.enabled ?? false,
    ...(prompts.length > 0 ? { suggestedPrompts: prompts } : {}),
    ...(keywords.length > 0 ? { channelKeywords: keywords } : {}),
  };
  if (slack.enabled && (!slack.botToken || !slack.signingSecret)) {
    throw new ValidationError("Bot token and signing secret are required to enable Slack");
  }
  const updated: Project = { ...project, slack, updatedAt: nextUpdatedAt(project.updatedAt) };
  await updateProject(repo, updated, project.updatedAt);
  return { project: updated, view: maskedView(cipher, updated) };
}

export async function disconnectProjectSlack(
  repo: ProjectRepository,
  name: string,
  userEmail: string,
  cipher: SecretCipher,
): Promise<ProjectSlackResult> {
  const project = await assertProjectWritable(repo, name, userEmail);
  const updated: Project = {
    ...project,
    slack: undefined,
    updatedAt: nextUpdatedAt(project.updatedAt),
  };
  await updateProject(repo, updated, project.updatedAt);
  return { project: updated, view: maskedView(cipher, updated) };
}

/** Decrypt credentials for runtime use. Only call at dispatch time. */
export function resolveProjectSlackRuntime(
  cipher: SecretCipher,
  project: Project,
): { botToken: string; signingSecret: string } | null {
  const slack = project.slack;
  if (!slack?.enabled || !slack.botToken || !slack.signingSecret) {
    return null;
  }
  return {
    botToken: cipher.decrypt(slack.botToken),
    signingSecret: cipher.decrypt(slack.signingSecret),
  };
}

function defaultAgentDescription(project: Project): string {
  return `AgentDure bot for the ${project.name} project`;
}

/** Slack app manifest for this project's dedicated bot. */
export function buildProjectSlackManifest(
  project: Project,
  baseUrl: string,
): Record<string, unknown> {
  return {
    display_information: {
      name: project.displayName.slice(0, 35),
      description: defaultAgentDescription(project),
      background_color: "#2b5cd9",
    },
    features: {
      app_home: {
        home_tab_enabled: true,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: { display_name: project.displayName.slice(0, 80), always_online: true },
      // The agent messaging experience. `agent_description` is required once
      // this key is present, and it is the only text a user sees before asking
      // anything — an empty view reads as a bot that is not running.
      agent_view: {
        agent_description: (project.description.trim() || defaultAgentDescription(project)).slice(
          0,
          MAX_AGENT_DESCRIPTION_LENGTH,
        ),
        suggested_prompts: (project.slack?.suggestedPrompts ?? []).slice(0, MAX_SUGGESTED_PROMPTS),
      },
    },
    oauth_config: {
      redirect_urls: [`${baseUrl}${MCP_OAUTH_CALLBACK_PATH}`],
      scopes: {
        bot: [
          "app_mentions:read",
          "assistant:write",
          "channels:history",
          "channels:join",
          "channels:read",
          "chat:write",
          "emoji:read",
          "files:read",
          "files:write",
          "groups:history",
          "groups:read",
          "im:history",
          "im:write",
          "incoming-webhook",
          "reactions:read",
          "reactions:write",
          "users:read.email",
          "users:read",
          "users.profile:read",
        ],
      },
      pkce_enabled: false,
    },
    settings: {
      event_subscriptions: {
        request_url: `${baseUrl}${eventsPathFor(project.name)}`,
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
          "message.channels",
          "message.groups",
          "message.im",
        ],
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
      is_mcp_enabled: true,
    },
  };
}

/**
 * Verify a project's stored bot token against Slack. Owner-gated by the caller;
 * `authTest` is injected so this stays free of the Slack HTTP client.
 */
export async function testProjectSlack(
  repo: ProjectRepository,
  name: string,
  userEmail: string,
  cipher: SecretCipher,
  authTest: (botToken: string) => Promise<{ team?: string; user?: string }>,
): Promise<{ ok: true; team?: string; botUser?: string } | { ok: false }> {
  const project = await assertProjectWritable(repo, name, userEmail);
  const runtime = resolveProjectSlackRuntime(cipher, project);
  if (!runtime) {
    return { ok: false };
  }
  const identity = await authTest(runtime.botToken);
  return { ok: true, team: identity.team, botUser: identity.user };
}

/**
 * What one Slack event on this project's endpoint needs before it can be
 * handled: the credentials to verify it with, and the policy that decides
 * whether it is for this bot at all. Null when the project is missing or its
 * bot is not enabled. No session is involved — the signature is the
 * authentication.
 *
 * The keywords ride along rather than being fetched by the gate: this read
 * already happens on every delivered event, and a second one to ask what the
 * project listens for would double the cost of ignoring a message.
 */
export interface SlackEventBinding {
  projectName: string;
  botToken: string;
  signingSecret: string;
  channelKeywords: string[];
}

export async function resolveSlackEventBinding(
  repo: ProjectRepository,
  projectName: string,
  cipher: SecretCipher,
): Promise<SlackEventBinding | null> {
  const project = await repo.get(projectName);
  const runtime = project ? resolveProjectSlackRuntime(cipher, project) : null;
  if (!project || !runtime) {
    return null;
  }
  return {
    projectName: project.name,
    ...runtime,
    channelKeywords: project.slack?.channelKeywords ?? [],
  };
}

/**
 * The project-Slack surface bound to its repository and cipher, composed once
 * by the composition root. Same split as {@link createProjectUseCases}: a route
 * takes the bound object, an application module that already holds the
 * repository calls the function.
 *
 * `authTest` is bound here too. It is the Slack HTTP client, deferred by the
 * composition root so a route that wanted a project did not load it — and a
 * route choosing which client verifies a token is the same defect as a route
 * choosing which cipher decrypts one.
 */
export interface ProjectSlackUseCases {
  get(name: string, userEmail: string): Promise<ProjectSlackResult>;
  update(name: string, update: ProjectSlackUpdate, userEmail: string): Promise<ProjectSlackResult>;
  disconnect(name: string, userEmail: string): Promise<ProjectSlackResult>;
  test(name: string, userEmail: string): Promise<{ ok: true; team?: string; botUser?: string } | { ok: false }>;
  /** No session involved — the request signature is the authentication. */
  resolveEventBinding(projectName: string): Promise<SlackEventBinding | null>;
}

export function createProjectSlackUseCases(deps: {
  projects: ProjectRepository;
  cipher: SecretCipher;
  authTest: (botToken: string) => Promise<{ team?: string; user?: string }>;
}): ProjectSlackUseCases {
  return {
    get: (name, userEmail) => getProjectSlack(deps.projects, name, userEmail, deps.cipher),
    update: (name, update, userEmail) =>
      updateProjectSlack(deps.projects, name, update, userEmail, deps.cipher),
    disconnect: (name, userEmail) =>
      disconnectProjectSlack(deps.projects, name, userEmail, deps.cipher),
    test: (name, userEmail) =>
      testProjectSlack(deps.projects, name, userEmail, deps.cipher, deps.authTest),
    resolveEventBinding: (projectName) =>
      resolveSlackEventBinding(deps.projects, projectName, deps.cipher),
  };
}
