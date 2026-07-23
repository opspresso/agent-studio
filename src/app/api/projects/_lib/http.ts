import type { Project } from "@/domain/project/types";

/**
 * Strip stored Slack credentials before returning a project to clients.
 * The slack field collapses to a configured/enabled summary; secrets are
 * readable only through the masked /slack endpoint.
 */
export function sanitizeProject(project: Project): Omit<Project, "slack"> & {
  slack?: { enabled: boolean; configured: boolean };
} {
  const { slack, ...rest } = project;
  if (!slack) {
    return rest;
  }
  return {
    ...rest,
    slack: { enabled: slack.enabled, configured: Boolean(slack.botToken && slack.signingSecret) },
  };
}
