import type { Agent } from "@/domain/agent/types";
import { agentHasAudioTools } from "@/domain/agent/audioAccess";
import { agentHasWorkspaceTools } from "@/domain/agent/workspaceAccess";

/** What a client may know about a bot integration: whether one is on, and whether it is complete. */
export interface IntegrationSummary {
  enabled: boolean;
  configured: boolean;
}

/**
 * An agent as every agent response carries it — the shape the console's
 * client types against, so the two ends of the wire cannot drift. The domain
 * `Agent` is *not* what a route answers with: the bot integrations collapse
 * to summaries, which is exactly what lets a client ask "is Slack connected"
 * without ever seeing a credential. Audio and Workspace tool flags give the
 * Agent navigation what it needs without exposing configuration or making a
 * second read of the same Agent row.
 */
export type SanitizedAgent = Omit<Agent, "slack" | "telegram" | "teams" | "configuration"> & {
  configured: boolean;
  audioToolsEnabled: boolean;
  workspaceToolsEnabled: boolean;
  slack?: IntegrationSummary;
  telegram?: IntegrationSummary;
  teams?: IntegrationSummary;
};

/** Strip bot credentials and configuration from catalog responses. */
export function sanitizeAgent(agent: Agent): SanitizedAgent {
  const { slack, telegram, teams, configuration: _configuration, ...rest } = agent;
  return {
    ...rest,
    configured: agent.configuration !== undefined,
    audioToolsEnabled: agentHasAudioTools(agent),
    workspaceToolsEnabled: agentHasWorkspaceTools(agent),
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
