/**
 * Composition root. Wires domain repository ports to their DynamoDB adapters and
 * exposes the `executionDeps` bundle consumed by the execution facade
 * (`@/application/execution/runProject`). Route handlers and pages import repos
 * and deps from here — never from `infrastructure/` directly.
 *
 * Adapters that pull a heavy SDK are reached through `import()` rather than a
 * top-level import. Anything named at module scope is retained for every
 * consumer of this file, so a route that wanted one repository was also loading
 * the Slack client, the GitHub client, the A2A card renderer, and — through the
 * remote-agent dispatcher — the `@a2a-js/sdk` client.
 * Each of those is already awaited at its call site, so deferring costs nothing.
 * The one that stays eager is `mcpToolProbe`: its `invalidateDiscovery` is
 * synchronous, and making it async would let a later read win the race against
 * the invalidation it was supposed to follow.
 */

import { projectRepository } from "@/infrastructure/db/repositories/projectRepository";
import { versionRepository } from "@/infrastructure/db/repositories/versionRepository";
import { skillRepository } from "@/infrastructure/db/repositories/skillRepository";
import { mcpRepository } from "@/infrastructure/db/repositories/mcpRepository";
import { mcpConnectionRepository } from "@/infrastructure/db/repositories/mcpConnectionRepository";
import { mcpOAuthStateRepository } from "@/infrastructure/db/repositories/mcpOAuthStateRepository";
import { externalAgentRepository } from "@/infrastructure/db/repositories/externalAgentRepository";
import { usageRepository } from "@/infrastructure/db/repositories/usageRepository";
import { createChannel } from "@/infrastructure/llm/channel";
import { createImageChannel } from "@/infrastructure/llm/imageChannel";
import { parseProviderConfigs, resolveProviderTarget } from "@/infrastructure/llm/providers";
import { traceRepository } from "@/infrastructure/db/repositories/traceRepository";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import { urlPolicy } from "@/infrastructure/net/urlPolicy";
import { mcpToolProbe } from "@/infrastructure/mcp/toolProbe";
import { oauthMetadataClient } from "@/infrastructure/mcp/oauthMetadata";
import type { McpSessionFactory } from "@/domain/mcp/toolSession";
import type { RemoteAgentDispatcher } from "@/domain/agent/dispatcher";
import { settingsRepository } from "@/infrastructure/db/repositories/settingsRepository";
import { createA2aTaskStore } from "@/infrastructure/a2a/taskStore";
import { dbReachable, llmReachable } from "@/infrastructure/health/probes";
import { checkReadiness } from "@/application/health/readiness";
import { createAgentUseCases } from "@/application/agent/agentUseCases";
import { createMcpUseCases } from "@/application/mcp/mcpUseCases";
import { createMcpAuthUseCases } from "@/application/mcp/mcpAuthUseCases";
import { createSkillUseCases } from "@/application/skill/skillUseCases";
import { createSettingsUseCases } from "@/application/settings/settingsUseCases";
import { syncSkillsFromSnapshot } from "@/application/skill/syncSkills";
import type { A2aExposureDeps } from "@/application/a2a/exposure";
import {
  getLlmChannelConfig,
  getLlmProviderConfigs,
  getSkillsRepoConfig,
} from "./runtime-settings";

/**
 * Reading runtime settings is the composition root's job: the LLM adapters take
 * this resolver instead of reaching into `lib/`. It runs per request, so a
 * settings change lands on the next cache refresh exactly as before.
 */
const resolveTarget = async (modelId: string) => {
  const [providers, defaultChannel] = await Promise.all([
    getLlmProviderConfigs(),
    getLlmChannelConfig(),
  ]);
  return resolveProviderTarget(modelId, providers, defaultChannel);
};

const channel = createChannel(resolveTarget);
const imageChannel = createImageChannel(resolveTarget);

const remoteAgents: RemoteAgentDispatcher = {
  send: async (target, message, signal) =>
    (await import("@/infrastructure/agent/dispatcher")).remoteAgentDispatcher.send(
      target,
      message,
      signal,
    ),
  probe: async (target, message) =>
    (await import("@/infrastructure/agent/dispatcher")).remoteAgentDispatcher.probe(
      target,
      message,
    ),
};

const mcpSessions: McpSessionFactory = {
  open: async (servers, reservedNames, signal) =>
    (await import("@/infrastructure/mcp/sessionFactory")).mcpSessionFactory.open(
      servers,
      reservedNames,
      signal,
    ),
};

export {
  channel,
  imageChannel,
  projectRepository,
  versionRepository,
  traceRepository,
  usageRepository,
  createA2aTaskStore,
  secretCipher,
  urlPolicy,
  mcpConnectionRepository,
  mcpOAuthStateRepository,
};

/**
 * Registry slice singletons. Each slice exports only its `createXUseCases`
 * factory; the instance is composed here so a repository or port implementation
 * has exactly one wiring site.
 */
export const agentUseCases = createAgentUseCases(externalAgentRepository, secretCipher, urlPolicy, remoteAgents);
export const mcpUseCases = createMcpUseCases(mcpRepository, secretCipher, urlPolicy, mcpToolProbe);
export const mcpAuthUseCases = createMcpAuthUseCases({
  mcps: mcpRepository,
  metadata: oauthMetadataClient,
  urlPolicy,
});
export const skillUseCases = createSkillUseCases(skillRepository);
export const settingsUseCases = createSettingsUseCases(settingsRepository, secretCipher, process.env, parseProviderConfigs);

/**
 * Pull the skills repo and upsert every SKILL.md. Assembled here so the route
 * never holds a repository — it only decides how failures map to status codes.
 * The caller passes the config it already resolved: reading it again here would
 * be a second settings load, and one that can straddle the cache TTL and pick a
 * different repo than the caller's own guard checked.
 */
export const syncSkillsFromRepo = async (
  repoConfig: Awaited<ReturnType<typeof getSkillsRepoConfig>>,
) => {
  const { fetchSkillsRepoSnapshot } = await import("@/infrastructure/github/skillsRepoClient");
  return syncSkillsFromSnapshot(skillRepository, await fetchSkillsRepoSnapshot(repoConfig));
};

/** A2A exposure: repositories plus the card renderer. */
export const a2aExposureDeps: A2aExposureDeps = {
  projects: projectRepository,
  versions: versionRepository,
  buildCard: async (project, version) =>
    (await import("@/infrastructure/a2a/cards")).buildAgentCard(project, version),
  cardUrlFor: async (projectName) =>
    (await import("@/infrastructure/a2a/cards")).buildProjectAgentCardUrl(projectName),
};

/** Slack Web API access for the per-project bot test. */
export const slackAuthTest = async (botToken: string) =>
  (await import("@/infrastructure/slack/client")).slackClient.authTest(botToken);

/** Registry lookups a version's mcp/skill/subagent references are validated against. */
export const versionRefRepos = {
  skills: skillRepository,
  mcps: mcpRepository,
  externalAgents: externalAgentRepository,
  projects: projectRepository,
};

/** Readiness snapshot for the /api/ready probe (DynamoDB + LLM channel). */
export const readinessReport = () =>
  checkReadiness({ checkDb: dbReachable, checkLlm: () => llmReachable(getLlmChannelConfig) });

const configuredTraceSampleRate = Number(process.env.TRACE_SAMPLE_RATE ?? "0.1");
const traceSampleRate = Number.isFinite(configuredTraceSampleRate)
  ? Math.min(Math.max(configuredTraceSampleRate, 0), 1)
  : 0.1;

/** Repository + channel bundle passed to the execution facade (executeVersion/Stream/Agent). */
export const executionDeps = {
  projects: projectRepository,
  versions: versionRepository,
  skills: skillRepository,
  mcps: mcpRepository,
  externalAgents: externalAgentRepository,
  usage: usageRepository,
  channel,
  imageChannel,
  cipher: secretCipher,
  urlPolicy,
  remoteAgents,
  mcpSessions,
  traces: traceRepository,
  traceSampleRate,
};

/** Dependencies for image-generation projects. */
export const imageDeps = {
  imageChannel,
  usage: usageRepository,
  traces: traceRepository,
  traceSampleRate,
};
