import type { Project } from "@/domain/project/types";
import { projectHasAudioTools } from "@/domain/project/audioAccess";
import { projectHasWorkspaceTools } from "@/domain/project/workspaceAccess";

/** What a client may know about a bot integration: whether one is on, and whether it is complete. */
export interface IntegrationSummary {
  enabled: boolean;
  configured: boolean;
}

/**
 * A project as every project response carries it — the shape the console's
 * client types against, so the two ends of the wire cannot drift. The domain
 * `Project` is *not* what a route answers with: the bot integrations collapse
 * to summaries, which is exactly what lets a client ask "is Slack connected"
 * without ever seeing a credential. Audio and Workspace tool flags give the
 * Agent navigation what it needs without exposing configuration or making a
 * second read of the same Project row.
 */
export type SanitizedProject = Omit<Project, "slack" | "telegram" | "teams" | "configuration"> & {
  configured: boolean;
  audioToolsEnabled: boolean;
  workspaceToolsEnabled: boolean;
  slack?: IntegrationSummary;
  telegram?: IntegrationSummary;
  teams?: IntegrationSummary;
};

/**
 * Strip bot credentials and configuration. The invite list is included only
 * for a manager; visibility alone does not reveal other members' addresses.
 */
export function sanitizeProject(
  project: Project,
  opts: { withMemberEmails?: boolean } = {},
): SanitizedProject {
  const { slack, telegram, teams, memberEmails, configuration: _configuration, ...rest } = project;
  return {
    ...rest,
    configured: project.configuration !== undefined,
    audioToolsEnabled: projectHasAudioTools(project),
    workspaceToolsEnabled: projectHasWorkspaceTools(project),
    ...(opts.withMemberEmails && memberEmails !== undefined ? { memberEmails } : {}),
    ...(slack
      ? {
          slack: {
            enabled: slack.enabled,
            configured: Boolean(slack.botToken && slack.signingSecret),
          },
        }
      : {}),
    ...(telegram
      ? {
          telegram: {
            enabled: telegram.enabled,
            configured: Boolean(telegram.botToken && telegram.webhookSecret),
          },
        }
      : {}),
    ...(teams
      ? {
          teams: {
            enabled: teams.enabled,
            configured: Boolean(teams.appId && teams.appPassword),
          },
        }
      : {}),
  };
}
