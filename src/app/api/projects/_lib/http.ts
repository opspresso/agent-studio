import type { Project } from "@/domain/project/types";

/** What a client may know about a bot integration: whether one is on, and whether it is complete. */
export interface IntegrationSummary {
  enabled: boolean;
  configured: boolean;
}

/**
 * Strip stored bot credentials before returning a project to clients.
 * The slack and telegram fields collapse to a configured/enabled summary;
 * secrets are readable only through the masked /slack and /telegram endpoints.
 */
export function sanitizeProject(project: Project): Omit<Project, "slack" | "telegram"> & {
  slack?: IntegrationSummary;
  telegram?: IntegrationSummary;
} {
  const { slack, telegram, ...rest } = project;
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
  };
}
