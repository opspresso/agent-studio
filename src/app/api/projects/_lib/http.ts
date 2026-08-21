import type { Project } from "@/domain/project/types";

/** What a client may know about a bot integration: whether one is on, and whether it is complete. */
export interface IntegrationSummary {
  enabled: boolean;
  configured: boolean;
}

/**
 * Strip stored bot credentials before returning a project to clients.
 * The slack, telegram and teams fields collapse to a configured/enabled
 * summary; secrets are readable only through the masked /slack, /telegram and
 * /teams endpoints.
 *
 * The invite list is stripped too, unless the caller says the viewer manages
 * this project: `memberEmails` is a roster of third-party addresses, and a
 * project's being visible never meant its reader may learn who else was
 * invited — least of all after the owner flips it public, when the stale list
 * would ride along to everyone. Only the owner's settings page needs it.
 */
/**
 * A project as every project response carries it — the shape the console's
 * client types against, so the two ends of the wire cannot drift. The domain
 * `Project` is *not* what a route answers with: the bot integrations collapse
 * to summaries, which is exactly what lets a client ask "is Slack connected"
 * without ever seeing a credential.
 */
export type SanitizedProject = Omit<Project, "slack" | "telegram" | "teams"> & {
  slack?: IntegrationSummary;
  telegram?: IntegrationSummary;
  teams?: IntegrationSummary;
};

export function sanitizeProject(
  project: Project,
  opts: { withMemberEmails?: boolean } = {},
): SanitizedProject {
  const { slack, telegram, teams, memberEmails, ...rest } = project;
  return {
    ...rest,
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
