import { ValidationError } from "@/application/project/errors";
import { assertProjectOwner, getProject } from "@/application/project/projectUseCases";
import {
  MASKED_SECRET,
  decryptSecret,
  encryptSecret,
} from "@/lib/secret-encryption";
import type { Project, SlackIntegration } from "@/domain/project/types";
import type { ProjectRepository } from "@/domain/project/repository";

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

function maskedView(project: Project): ProjectSlackView {
  const slack = project.slack;
  return {
    enabled: slack?.enabled ?? false,
    configured: Boolean(slack?.botToken && slack.signingSecret),
    botToken: slack?.botToken ? MASKED_SECRET : "",
    signingSecret: slack?.signingSecret ? MASKED_SECRET : "",
    eventsPath: eventsPathFor(project.name),
  };
}

export async function getProjectSlack(
  repo: ProjectRepository,
  name: string,
): Promise<ProjectSlackView> {
  return maskedView(await getProject(repo, name));
}

/** Merge semantics: masked/empty input keeps the stored secret; plaintext replaces it. */
function mergeSecret(stored: string | undefined, input: string | undefined): string {
  if (input === undefined || input === MASKED_SECRET || input === "") {
    return stored ?? "";
  }
  return encryptSecret(input);
}

export async function updateProjectSlack(
  repo: ProjectRepository,
  name: string,
  update: ProjectSlackUpdate,
  userEmail: string,
): Promise<ProjectSlackView> {
  const project = await assertProjectOwner(repo, name, userEmail);
  if (project.projectType !== "agent") {
    throw new ValidationError("Slack bots can only be attached to agent projects");
  }
  const slack: SlackIntegration = {
    botToken: mergeSecret(project.slack?.botToken, update.botToken),
    signingSecret: mergeSecret(project.slack?.signingSecret, update.signingSecret),
    enabled: update.enabled ?? project.slack?.enabled ?? false,
  };
  if (slack.enabled && (!slack.botToken || !slack.signingSecret)) {
    throw new ValidationError("Bot token and signing secret are required to enable Slack");
  }
  const updated: Project = { ...project, slack, updatedAt: new Date().toISOString() };
  await repo.update(updated);
  return maskedView(updated);
}

export async function disconnectProjectSlack(
  repo: ProjectRepository,
  name: string,
  userEmail: string,
): Promise<ProjectSlackView> {
  const project = await assertProjectOwner(repo, name, userEmail);
  const updated: Project = { ...project, slack: undefined, updatedAt: new Date().toISOString() };
  await repo.update(updated);
  return maskedView(updated);
}

/** Decrypt credentials for runtime use. Only call at dispatch time. */
export function resolveProjectSlackRuntime(
  project: Project,
): { botToken: string; signingSecret: string } | null {
  const slack = project.slack;
  if (!slack?.enabled || !slack.botToken || !slack.signingSecret) {
    return null;
  }
  return {
    botToken: decryptSecret(slack.botToken),
    signingSecret: decryptSecret(slack.signingSecret),
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
