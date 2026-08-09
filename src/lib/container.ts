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
import { withTraceExport } from "@/infrastructure/telemetry/withTraceExport";
import type { Trace } from "@/domain/trace/types";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import { urlPolicy } from "@/infrastructure/net/urlPolicy";
import { mcpToolProbe } from "@/infrastructure/mcp/toolProbe";
import { config } from "./config";
import { oauthMetadataClient } from "@/infrastructure/mcp/oauthMetadata";
import { oauthClient } from "@/infrastructure/mcp/oauthClient";
import type { McpSessionFactory } from "@/domain/mcp/toolSession";
import type { RemoteAgentDispatcher } from "@/domain/agent/dispatcher";
import { settingsRepository } from "@/infrastructure/db/repositories/settingsRepository";
import { auditRepository } from "@/infrastructure/db/repositories/auditRepository";
import { memberRepository } from "@/infrastructure/db/repositories/memberRepository";
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
import { createProjectUseCases, setAdminCheck } from "@/application/project/projectUseCases";
import { createVersionUseCases } from "@/application/project/versionUseCases";
import { createApiTokenUseCases } from "@/application/project/apiTokenUseCases";
import { createA2aClientKeyUseCases } from "@/application/a2a/clientKeyUseCases";
import { a2aClientKeyRepository } from "@/infrastructure/db/repositories/a2aClientKeyRepository";
import { createProjectSlackUseCases } from "@/application/slack/projectSlack";
import { setAuditSink } from "@/application/audit/recordAudit";
import { createAuditUseCases } from "@/application/audit/auditUseCases";
import { createMemberUseCases } from "@/application/member/memberUseCases";
import {
  getLlmChannelConfig,
  getLlmProviderConfigs,
  getPublicBaseUrl,
  getSkillsRepoConfig,
  getToolsRepoConfig,
  getUnknownModelPolicy,
  isConfiguredAdmin,
} from "./runtime-settings";

// The write override's admin list is pushed into the use case here rather than
// imported by it — a static import would drag the settings store (and its
// DynamoDB client) into the application layer.
setAdminCheck(isConfiguredAdmin);

// Same shape, same reason: the audit store is pushed into the writer rather
// than threaded through every act that records one, because a call site that
// forgot the argument would leave exactly one act untracked.
//
// `instrumentation.ts` wires the same sink on the server's awaited boot path,
// since a recording route need not import this module at all. This call is what
// covers the processes with no instrumentation hook — the scripts and the
// integration check compose the container and nothing else. Idempotent: both
// push the same repository.
setAuditSink(auditRepository);

export const auditUseCases = createAuditUseCases(auditRepository);
export const memberUseCases = createMemberUseCases(memberRepository);

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

/**
 * Finished traces double as OTLP spans when `OTEL_EXPORTER_OTLP_ENDPOINT` is
 * set — unset means no export at all. The OTEL SDK sits behind a deferred
 * import like the other heavy adapters, resolved once on the first export.
 */
const otelEndpoint = config.otelExporterEndpoint;
let otelExport: Promise<(trace: Trace) => void> | undefined;
const runTraceRepository = otelEndpoint
  ? withTraceExport(traceRepository, async (trace) => {
      otelExport ??= import("@/infrastructure/telemetry/otelTraceExport").then((m) =>
        m.createOtelTraceExport({
          endpoint: otelEndpoint,
          headers: config.otelExporterHeaders,
          serviceName: "agent-studio",
        }),
      );
      (await otelExport)(trace);
    })
  : traceRepository;

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
/**
 * The project slice, which route handlers used to compose for themselves:
 * twenty of them imported `projectRepository` from here to hand it straight
 * back to a use case. Composed once now, like every other slice.
 */
export const projectUseCases = createProjectUseCases(projectRepository);
export const apiTokenUseCases = createApiTokenUseCases(projectRepository, secretCipher);
export const a2aClientKeyUseCases = createA2aClientKeyUseCases(
  a2aClientKeyRepository,
  secretCipher,
);
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
  actorEmail: string,
  selection?: SyncSelection,
) => {
  const { fetchSkillsRepoSnapshot } = await import("@/infrastructure/github/skillsRepoClient");
  return syncSkillsFromSnapshot(
    skillRepository,
    skillUseCases,
    await fetchSkillsRepoSnapshot(repoConfig),
    actorEmail,
    selection,
  );
};

/**
 * Pull the tools repo and register every TOOL.md that is not registered yet.
 * Assembled here for the same reason the skills sync is, and it goes through
 * `mcpUseCases` rather than the repository so a synced entry faces the same URL
 * guard and header encryption a typed one does.
 */
export const syncToolsFromRepo = async (
  repoConfig: Awaited<ReturnType<typeof getToolsRepoConfig>>,
  actorEmail: string,
  selection?: SyncSelection,
) => {
  const { fetchToolsRepoSnapshot } = await import("@/infrastructure/github/toolsRepoClient");
  return syncToolsFromSnapshot(
    mcpUseCases,
    await fetchToolsRepoSnapshot(repoConfig),
    actorEmail,
    selection,
  );
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

/**
 * Slack Web API access for the per-project bot test. Module-local for the same
 * reason as `versionRefRepos`: `projectSlackUseCases` below is the only
 * consumer now, and leaving it exported preserves exactly the defect the
 * comment there names — a route picking which client verifies a token.
 */
const slackAuthTest = async (botToken: string) =>
  (await import("@/infrastructure/slack/client")).slackClient.authTest(botToken);

/**
 * The project-Slack surface, composed here rather than at each of the three
 * routes that used it — two of which were reaching for `projectRepository` and
 * `secretCipher` to do it. Below `slackAuthTest` because it binds it: the
 * client stays deferred, so a route that wanted a project still does not load
 * it.
 */
export const projectSlackUseCases = createProjectSlackUseCases({
  projects: projectRepository,
  cipher: secretCipher,
  authTest: slackAuthTest,
});

/** Slack profile lookup (cached) for putting a name on a `slack:` usage row. */
export const slackUserProfile = async (botToken: string, userId: string) =>
  (await import("@/infrastructure/slack/client")).slackClient.userProfile(botToken, userId);

/**
 * Registry lookups a version's mcp/skill/subagent references are validated
 * against. Module-local: the version slice below is the only consumer, and an
 * exported bundle of repositories is the door the factory just closed —
 * `REPOSITORIES_THE_ROUTES_NO_LONGER_COMPOSE` bans the two names, not a object
 * holding them.
 */
const versionRefRepos = {
  skills: skillRepository,
  mcps: mcpRepository,
  externalAgents: externalAgentRepository,
  projects: projectRepository,
};

export const versionUseCases = createVersionUseCases({
  versions: versionRepository,
  projects: projectRepository,
  refs: versionRefRepos,
  cipher: secretCipher,
});

/** Readiness snapshot for the /api/ready probe (DynamoDB + LLM channel). */
export const readinessReport = () =>
  checkReadiness({ checkDb: dbReachable, checkLlm: () => llmReachable(getLlmChannelConfig) });

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
  traces: runTraceRepository,
  traceSampleRate: config.traceSampleRate,
  slack: costAlertSlack,
  runSlots: runSlotRepository,
  limits: concurrencyLimits,
  unknownModelPolicy: getUnknownModelPolicy,
};

/** Dependencies for image-generation projects. */
export const imageDeps: ImageGenerationDeps = {
  imageChannel,
  usage: usageRepository,
  traces: runTraceRepository,
  traceSampleRate: config.traceSampleRate,
  cipher: secretCipher,
  slack: costAlertSlack,
  runSlots: runSlotRepository,
  limits: concurrencyLimits,
  unknownModelPolicy: getUnknownModelPolicy,
};

/**
 * The webhook delivery path. `run` binds the facade's chunk-stream entry point
 * and nothing else: which project type runs which way, and what an image run's
 * chunks look like, are both decided there. This file used to answer the first
 * question and assemble the second by hand — a wiring site making a dispatch
 * decision, which is how the image path's ending announcement went missing once.
 */
export const triggerRunnerDeps: TriggerRunnerDeps = {
  triggers: triggerRepository,
  projects: projectRepository,
  versions: versionRepository,
  cipher: secretCipher,
  runSlots: runSlotRepository,
  run: async function* (input) {
    const { streamProjectRun } = await import("@/application/execution/runProject");
    yield* streamProjectRun(executionDeps, {
      project: input.project,
      version: input.version,
      ...(input.variables ? { variables: input.variables } : {}),
      messages: input.message ? [{ role: "user", content: input.message }] : [],
      actor: input.actor,
    });
  },
};
