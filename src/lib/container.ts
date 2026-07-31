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
import { config } from "./config";
import { oauthMetadataClient } from "@/infrastructure/mcp/oauthMetadata";
import { oauthClient } from "@/infrastructure/mcp/oauthClient";
import type { McpSessionFactory } from "@/domain/mcp/toolSession";
import type { RemoteAgentDispatcher } from "@/domain/agent/dispatcher";
import { settingsRepository } from "@/infrastructure/db/repositories/settingsRepository";
import { runSlotRepository } from "@/infrastructure/db/repositories/runSlotRepository";
import { triggerRepository } from "@/infrastructure/db/repositories/triggerRepository";
import { createA2aTaskStore } from "@/infrastructure/a2a/taskStore";
import { dbReachable, llmReachable } from "@/infrastructure/health/probes";
import { checkReadiness } from "@/application/health/readiness";
import { createAgentUseCases } from "@/application/agent/agentUseCases";
import { createMcpUseCases } from "@/application/mcp/mcpUseCases";
import { createManagedMcpUseCases } from "@/application/mcp/managedMcpUseCases";
import { createSsmProvisioner } from "@/infrastructure/mcp/ssmProvisioner";
import { createDockerProvisioner } from "@/infrastructure/mcp/dockerProvisioner";
import { createMcpAuthUseCases } from "@/application/mcp/mcpAuthUseCases";
import { createMcpAuthProvider } from "@/application/mcp/mcpAuthProvider";
import { createSkillUseCases } from "@/application/skill/skillUseCases";
import { createTriggerUseCases } from "@/application/trigger/triggerUseCases";
import type { TriggerRunnerDeps } from "@/application/trigger/runTrigger";
import { createSettingsUseCases } from "@/application/settings/settingsUseCases";
import { syncSkillsFromSnapshot } from "@/application/skill/syncSkills";
import { syncToolsFromSnapshot } from "@/application/mcp/syncTools";
import type { SyncSelection } from "@/domain/sync/types";
import type { A2aExposureDeps } from "@/application/a2a/exposure";
import type { CostAlertSlack } from "@/application/usage/costGuard";
import type { ConcurrencyLimits } from "@/application/execution/concurrencyGuard";
import type { ExecutionDeps } from "@/application/execution/deps";
import type { ImageGenerationDeps } from "@/application/image/generateImage";
import {
  getLlmChannelConfig,
  getLlmProviderConfigs,
  getPublicBaseUrl,
  getSkillsRepoConfig,
  getToolsRepoConfig,
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
export const mcpUseCases = createMcpUseCases(
  mcpRepository,
  secretCipher,
  urlPolicy,
  mcpToolProbe,
  config.mcpInternalHostSuffixes,
);

/**
 * Managed MCP, when this deployment can start containers at all. Undefined
 * where it cannot: the routes answer 503 rather than pretend the feature
 * exists, which is honest about a half-configured environment.
 */
export const managedMcpUseCases =
  config.managedMcpInstanceId && config.managedMcpRegistry
    ? createManagedMcpUseCases({
        repo: mcpRepository,
        // `local` runs Docker here instead of reaching an instance through SSM:
        // the app and the container share a loopback interface on a developer's
        // machine, which is the only way to exercise this path without EC2.
        provisioner:
          config.managedMcpInstanceId === "local"
            ? createDockerProvisioner()
            : createSsmProvisioner({
                instanceId: config.managedMcpInstanceId,
                region: config.awsRegion,
                registry: config.managedMcpRegistry,
                networkContainer: config.managedMcpNetworkContainer,
              }),
        probe: mcpToolProbe,
        // Reachability is checked with the entry's own headers, which are
        // encrypted at rest — the probe needs them the way a dispatch does.
        cipher: secretCipher,
        now: () => new Date().toISOString(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      })
    : undefined;
const mcpAuthProvider = createMcpAuthProvider({
  connections: mcpConnectionRepository,
  oauth: oauthClient,
  cipher: secretCipher,
});
export const mcpAuthUseCases = createMcpAuthUseCases({
  mcps: mcpRepository,
  projects: projectRepository,
  connections: mcpConnectionRepository,
  states: mcpOAuthStateRepository,
  metadata: oauthMetadataClient,
  oauth: oauthClient,
  cipher: secretCipher,
  urlPolicy,
  probe: mcpToolProbe,
  authProvider: mcpAuthProvider,
  publicBaseUrl: getPublicBaseUrl,
  internalHostSuffixes: config.mcpInternalHostSuffixes,
});
export const skillUseCases = createSkillUseCases(skillRepository);
export const triggerUseCases = createTriggerUseCases({
  triggers: triggerRepository,
  projects: projectRepository,
  cipher: secretCipher,
});
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
  selection?: SyncSelection,
) => {
  const { fetchSkillsRepoSnapshot } = await import("@/infrastructure/github/skillsRepoClient");
  return syncSkillsFromSnapshot(skillRepository, await fetchSkillsRepoSnapshot(repoConfig), selection);
};

/**
 * Pull the tools repo and register every TOOL.md that is not registered yet.
 * Assembled here for the same reason the skills sync is, and it goes through
 * `mcpUseCases` rather than the repository so a synced entry faces the same URL
 * guard and header encryption a typed one does.
 */
export const syncToolsFromRepo = async (
  repoConfig: Awaited<ReturnType<typeof getToolsRepoConfig>>,
  selection?: SyncSelection,
) => {
  const { fetchToolsRepoSnapshot } = await import("@/infrastructure/github/toolsRepoClient");
  return syncToolsFromSnapshot(mcpUseCases, await fetchToolsRepoSnapshot(repoConfig), selection);
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

/** Slack profile lookup (cached) for putting a name on a `slack:` usage row. */
export const slackUserProfile = async (botToken: string, userId: string) =>
  (await import("@/infrastructure/slack/client")).slackClient.userProfile(botToken, userId);

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

/**
 * Slack access for the cost guard's threshold notification. Deferred like the
 * other Slack use so a route that only wanted a repository does not load the
 * client; the guard awaits it at the one point it actually posts.
 */
/**
 * Per-caller concurrency ceilings. Read once here rather than at each guard
 * call: the numbers come from boot env, and a getter per run would re-parse
 * them on every request.
 */
const concurrencyLimits: ConcurrencyLimits = {
  perActor: config.maxConcurrentRunsPerActor,
  a2a: config.maxConcurrentRunsA2a,
};

const costAlertSlack: CostAlertSlack = {
  postMessage: async (token, args) =>
    (await import("@/infrastructure/slack/client")).slackClient.postMessage(token, args),
};

/** Repository + channel bundle passed to the execution facade (executeVersion/Stream/Agent). */
export const executionDeps: ExecutionDeps = {
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
  mcpAuth: mcpAuthProvider,
  internalHostSuffixes: config.mcpInternalHostSuffixes,
  traces: traceRepository,
  traceSampleRate,
  slack: costAlertSlack,
  runSlots: runSlotRepository,
  limits: concurrencyLimits,
};

/** Dependencies for image-generation projects. */
export const imageDeps: ImageGenerationDeps = {
  imageChannel,
  usage: usageRepository,
  traces: traceRepository,
  traceSampleRate,
  cipher: secretCipher,
  slack: costAlertSlack,
  runSlots: runSlotRepository,
  limits: concurrencyLimits,
};

/**
 * The webhook delivery path. `run` binds the same dispatch every other entry
 * point uses — `runStrategyFor` decides, and an image project generates rather
 * than streaming — so a trigger cannot become a fifth place that re-encodes it.
 */
export const triggerRunnerDeps: TriggerRunnerDeps = {
  triggers: triggerRepository,
  projects: projectRepository,
  versions: versionRepository,
  cipher: secretCipher,
  runSlots: runSlotRepository,
  run: async function* (input) {
    const { runStrategyFor, executeProjectStream } = await import(
      "@/application/execution/runProject"
    );
    if (runStrategyFor(input.project) === "image") {
      const { generateImage } = await import("@/application/image/generateImage");
      const image = await generateImage(imageDeps, {
        project: input.project,
        version: input.version,
        ...(input.variables ? { variables: input.variables } : {}),
        ...(input.message ? { prompt: input.message } : {}),
        actor: input.actor,
      });
      yield { image: { b64: image.imageBase64, mimeType: image.mimeType } };
      return;
    }
    yield* executeProjectStream(executionDeps, {
      project: input.project,
      version: input.version,
      ...(input.variables ? { variables: input.variables } : {}),
      messages: input.message ? [{ role: "user", content: input.message }] : [],
      actor: input.actor,
    });
  },
};
