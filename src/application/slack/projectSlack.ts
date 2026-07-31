import { ConflictError, ValidationError, isConditionalWriteFailure } from "@/application/errors";
import { MCP_OAUTH_CALLBACK_PATH } from "@/application/mcp/mcpAuthUseCases";
import { assertProjectWritable, getProject } from "@/application/project/projectUseCases";
import type { SecretCipher } from "@/domain/security/secretCipher";
import type { Project, SlackIntegration } from "@/domain/project/types";
import type { ProjectRepository } from "@/domain/project/repository";
import type { SlackSuggestedPrompt } from "@/domain/slack/types";
import {
  MAX_PROMPT_MESSAGE_LENGTH,
  MAX_PROMPT_TITLE_LENGTH,
  MAX_SUGGESTED_PROMPTS,
} from "@/domain/slack/types";
import { nextUpdatedAt } from "@/application/project/timestamps";

/** Slack's cap on the agent overview shown above the Messages tab. */
const MAX_AGENT_DESCRIPTION_LENGTH = 300;

export interface ProjectSlackView {
  enabled: boolean;
  configured: boolean;
  botToken: string;
  signingSecret: string;
  eventsPath: string;
  /** Not a secret, unlike the two above — returned as stored. */
  suggestedPrompts: SlackSuggestedPrompt[];
}

export interface ProjectSlackUpdate {
  botToken?: string;
  signingSecret?: string;
  enabled?: boolean;
  suggestedPrompts?: SlackSuggestedPrompt[];
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
  };
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
  const slack: SlackIntegration = {
    botToken: mergeSecret(cipher, project.slack?.botToken, update.botToken),
    signingSecret: mergeSecret(cipher, project.slack?.signingSecret, update.signingSecret),
    enabled: update.enabled ?? project.slack?.enabled ?? false,
    ...(prompts.length > 0 ? { suggestedPrompts: prompts } : {}),
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
  return `Agent Studio bot for the ${project.name} project`;
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
        home_tab_enabled: false,
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
          "emoji:read",
          "app_mentions:read",
          "assistant:write",
          "channels:history",
          "chat:write",
          "groups:history",
          "im:history",
          "files:read",
          "files:write",
          "groups:read",
          "reactions:read",
          // `users.info` needs this and nothing more. `users.profile:read` and
          // `users:read.email` used to be requested here and were never called:
          // the caller block carries a name and a timezone, deliberately not an
          // email, so neither has anything left to buy.
          "users:read",
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
        bot_events: ["app_mention", "app_home_opened", "message.im"],
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
 * The credentials a Slack event on this project's endpoint must be verified
 * with, or null when the project is missing or its bot is not enabled. No
 * session is involved — the signature is the authentication.
 */
export async function resolveSlackEventBinding(
  repo: ProjectRepository,
  projectName: string,
  cipher: SecretCipher,
): Promise<{ projectName: string; botToken: string; signingSecret: string } | null> {
  const project = await repo.get(projectName);
  const runtime = project ? resolveProjectSlackRuntime(cipher, project) : null;
  if (!project || !runtime) {
    return null;
  }
  return { projectName: project.name, ...runtime };
}
