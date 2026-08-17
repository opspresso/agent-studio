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
 */
export function sanitizeProject(project: Project): Omit<Project, "slack" | "telegram" | "teams"> & {
  slack?: IntegrationSummary;
  telegram?: IntegrationSummary;
  teams?: IntegrationSummary;
} {
  const { slack, telegram, teams, ...rest } = project;
  return {
    ...rest,
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
