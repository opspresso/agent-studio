import { ConflictError, ValidationError } from "@/application/errors";
import { assertProjectOwner, getProject } from "@/application/project/projectUseCases";
import type { SecretCipher } from "@/domain/security/secretCipher";
import type { Project, SlackIntegration } from "@/domain/project/types";
import type { ProjectRepository } from "@/domain/project/repository";
import { nextUpdatedAt } from "@/application/project/timestamps";

export interface ProjectSlackView {
  enabled: boolean;
  configured: boolean;
  botToken: string;
  signingSecret: string;
  eventsPath: string;
}

export interface ProjectSlackUpdate {
  botToken?: string;
  signingSecret?: string;
  enabled?: boolean;
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
  };
}

export async function getProjectSlack(
  repo: ProjectRepository,
  name: string,
  cipher: SecretCipher,
): Promise<ProjectSlackView> {
  return maskedView(cipher, await getProject(repo, name));
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
    if (error instanceof Error && error.name === "ConditionalCheckFailedException") {
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
): Promise<ProjectSlackView> {
  const project = await assertProjectOwner(repo, name, userEmail);
  if (project.projectType !== "agent") {
    throw new ValidationError("Slack bots can only be attached to agent projects");
  }
  const slack: SlackIntegration = {
    botToken: mergeSecret(cipher, project.slack?.botToken, update.botToken),
    signingSecret: mergeSecret(cipher, project.slack?.signingSecret, update.signingSecret),
    enabled: update.enabled ?? project.slack?.enabled ?? false,
  };
  if (slack.enabled && (!slack.botToken || !slack.signingSecret)) {
    throw new ValidationError("Bot token and signing secret are required to enable Slack");
  }
  const updated: Project = { ...project, slack, updatedAt: nextUpdatedAt(project.updatedAt) };
  await updateProject(repo, updated, project.updatedAt);
  return maskedView(cipher, updated);
}

export async function disconnectProjectSlack(
  repo: ProjectRepository,
  name: string,
  userEmail: string,
  cipher: SecretCipher,
): Promise<ProjectSlackView> {
  const project = await assertProjectOwner(repo, name, userEmail);
  const updated: Project = {
    ...project,
    slack: undefined,
    updatedAt: nextUpdatedAt(project.updatedAt),
  };
  await updateProject(repo, updated, project.updatedAt);
  return maskedView(cipher, updated);
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

/** Slack app manifest for this project's dedicated bot. */
export function buildProjectSlackManifest(
  project: Project,
  baseUrl: string,
): Record<string, unknown> {
  return {
    display_information: {
      name: project.displayName.slice(0, 35),
      description: `Agent Studio bot for the ${project.name} project`,
      background_color: "#2b5cd9",
    },
    features: {
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: { display_name: project.displayName.slice(0, 80), always_online: true },
      agent_view: { suggested_prompts: [] },
    },
    oauth_config: {
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
          "users.profile:read",
          "groups:read",
          "reactions:read",
          "users:read",
          "users:read.email",
        ],
      },
      pkce_enabled: false,
    },
    settings: {
      event_subscriptions: {
        request_url: `${baseUrl}${eventsPathFor(project.name)}`,
        bot_events: ["app_mention", "message.im"],
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
      is_mcp_enabled: false,
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
  const project = await assertProjectOwner(repo, name, userEmail);
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
