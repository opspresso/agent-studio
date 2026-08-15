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

import { after } from "next/server";
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
import type { OtelTraceExport } from "@/infrastructure/telemetry/otelTraceExport";
import { onShutdown } from "@/shared/lifecycle";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import { urlPolicy } from "@/infrastructure/net/urlPolicy";
import { httpResourceReader } from "@/infrastructure/net/httpResource";
import { documentExtractor } from "@/infrastructure/llm/documentExtractor";
import { mcpToolProbe } from "@/infrastructure/mcp/toolProbe";
import { config } from "./config";
import { oauthMetadataClient } from "@/infrastructure/mcp/oauthMetadata";
import { oauthClient } from "@/infrastructure/mcp/oauthClient";
import type { McpSessionFactory } from "@/domain/mcp/toolSession";
import type { RemoteAgentDispatcher } from "@/domain/agent/dispatcher";
import { settingsRepository } from "@/infrastructure/db/repositories/settingsRepository";
import { artifactRepository } from "@/infrastructure/db/repositories/artifactRepository";
import {
  artifactObjectStore,
  isObjectStoreConfigured,
} from "@/infrastructure/storage/s3ObjectStore";
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
import { createPluginUseCases } from "@/application/plugin/pluginUseCases";
import { syncPluginsFromSnapshot } from "@/application/plugin/syncPlugins";
import { findRegistryBindings } from "@/application/plugin/bindingIndex";
import { ConflictError } from "@/application/errors";
import type { PluginSyncSelection } from "@/domain/plugin/sync";
import { pluginRepository } from "@/infrastructure/db/repositories/pluginRepository";
import {
  pluginSyncLock,
  pluginSyncReportRepository,
} from "@/infrastructure/db/repositories/pluginSyncRepository";
import { createTriggerUseCases } from "@/application/trigger/triggerUseCases";
import type { TriggerRunnerDeps } from "@/application/trigger/runTrigger";
import { createSettingsUseCases } from "@/application/settings/settingsUseCases";
import { createTestModel } from "@/application/llm/testModel";
import type { A2aExposureDeps } from "@/application/a2a/exposure";
import type { PostCostAlert } from "@/application/usage/costGuard";
import type { ConcurrencyLimits } from "@/application/run/concurrencyGuard";
import type { ExecutionDeps } from "@/application/execution/deps";
import type { ImageGenerationDeps } from "@/application/image/generateImage";
import type { CatalogIndexDeps } from "@/application/catalog/reindexCatalog";
import type { CatalogSearchDeps } from "@/application/catalog/searchCatalog";
import { cacheQueryEmbeddings } from "@/application/catalog/queryCache";
import { log } from "@/shared/logger";
import { bedrockEmbeddings } from "@/infrastructure/llm/bedrockEmbeddings";
import { cohereEmbeddings } from "@/infrastructure/llm/cohereEmbeddings";
import { openAiEmbeddings } from "@/infrastructure/llm/embeddings";
import { createS3VectorsStore } from "@/infrastructure/vector/s3VectorsStore";
import { createProjectUseCases, setAdminCheck } from "@/application/project/projectUseCases";
import { createTraceUseCases } from "@/application/trace/traceUseCases";
import { createUsageUseCases } from "@/application/usage/usageUseCases";
import { createVersionUseCases } from "@/application/project/versionUseCases";
import { createApiTokenUseCases } from "@/application/project/apiTokenUseCases";
import { createA2aClientKeyUseCases } from "@/application/a2a/clientKeyUseCases";
import { a2aClientKeyRepository } from "@/infrastructure/db/repositories/a2aClientKeyRepository";
import { createProjectSlackUseCases, resolveProjectSlackRuntime } from "@/application/slack/projectSlack";
import { createSlackWorkspaceReader } from "@/application/slack/workspaceRead";
import type { SlackReaderPort } from "@/domain/slack/reader";
import { setAuditSink } from "@/application/audit/recordAudit";
import { createAuditUseCases } from "@/application/audit/auditUseCases";
import { createMemberUseCases } from "@/application/member/memberUseCases";
import { createArtifactUseCases } from "@/application/artifact/artifactUseCases";
import {
  getEnabledModels,
  getLlmChannelConfig,
  getLlmProviderConfigs,
  getPluginsRepoConfig,
  getPublicBaseUrl,
  getUnknownModelPolicy,
} from "./runtime-settings";
import { getMemberTier, isEffectiveConfiguredAdminByEmail } from "./memberAccess";
import { actorKey, memberEmailFromActorKey, type RunActor } from "@/domain/execution/actor";
import { DEFAULT_MEMBER_TIER, type MemberTier } from "@/domain/member/tiers";
import { offeredModels } from "@/domain/llm/models";
import { composeCreateProjectWithInitialVersion } from "@/application/project/createProjectFlow";

// The write override's admin list is pushed into the use case here rather than
// imported by it — a static import would drag the settings store (and its
// DynamoDB client) into the application layer. The effective form, so a
// tier-admin may override a project write exactly as a listed admin does.
setAdminCheck(isEffectiveConfiguredAdminByEmail);

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

/**
 * Where a run's output is kept, or nothing.
 *
 * The two ports move together: a row naming an object nobody can sign is worse
 * than no row, and a stored object no row names cannot be found again to delete.
 * `undefined` is the whole feature being off — the same shape `catalogDeps`
 * takes when this deployment has no vector bucket.
 */
export const artifactStorage = isObjectStoreConfigured()
  ? { rows: artifactRepository, objects: artifactObjectStore }
  : undefined;

export const auditUseCases = createAuditUseCases(auditRepository);
export const memberUseCases = createMemberUseCases(memberRepository);

/**
 * Reading and removing what runs produced. Undefined when this deployment keeps
 * nothing — the routes then answer 404 rather than listing an empty gallery,
 * which would say "you have made nothing" to someone whose images were never
 * being kept in the first place.
 */
export const artifactUseCases = artifactStorage
  ? createArtifactUseCases(artifactStorage.rows, artifactStorage.objects, projectRepository)
  : undefined;

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

/** One-shot model probe for the /models console — the same channel a run uses. */
export const testModel = createTestModel(channel);

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
 * import like the other heavy adapters, resolved once on the first export —
 * and un-cached on failure, so one bad chunk load at a cold start costs one
 * trace, not every trace for the life of the process. The batch buffer is
 * flushed on drain; without that, every rollout discards its last spans.
 */
const otelEndpoint = config.otelExporterEndpoint;
let otelExport: Promise<OtelTraceExport> | undefined;
const runTraceRepository = otelEndpoint
  ? withTraceExport(traceRepository, async (trace) => {
      otelExport ??= import("@/infrastructure/telemetry/otelTraceExport")
        .then((m) => {
          const handle = m.createOtelTraceExport({
            endpoint: otelEndpoint,
            headers: config.otelExporterHeaders,
            serviceName: "agentdure",
          });
          onShutdown(() => handle.flush());
          return handle;
        })
        .catch((error: unknown) => {
          otelExport = undefined;
          throw error;
        });
      (await otelExport).exportTrace(trace);
    })
  : traceRepository;

// The narrow raw surface: the Slack event wiring site takes the two
// repositories, the A2A route takes its per-request task store. Everything
// else leaves this file already composed — a singleton nothing imports is a
// door with nothing behind it, and five of them stood open here.
export { projectRepository, versionRepository, createA2aTaskStore };

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
 * Which adapter embeds is a deployment fact, not a per-call one: an index is
 * built for one model's dimension *and* its space, and vectors from another are
 * not comparable to what is already in it. Changing this means rebuilding the
 * index.
 */
const EMBEDDINGS = {
  cohere: cohereEmbeddings,
  bedrock: bedrockEmbeddings,
  openai: openAiEmbeddings,
} as const;

/**
 * The capability catalog, when this deployment has a vector store to hold it.
 * Undefined where it does not: the reindex endpoint answers 503 and a run
 * resolves exactly the bindings its version names — which is what every run did
 * before the catalog existed, so the feature is off rather than half-present.
 *
 * One bag serves indexing and search: search needs two of these fields, and a
 * second object naming the same two would be a second place to keep the index
 * name and the embedding model agreeing.
 */
const vectorBucket = config.vectorBucketName;
export const catalogDeps: (CatalogIndexDeps & CatalogSearchDeps) | undefined = vectorBucket
  ? {
      skills: skillRepository,
      mcps: mcpRepository,
      externalAgents: externalAgentRepository,
      // The console's "test connection" probe, which already answers exactly
      // this question. A server that refuses is not an error here — it is
      // indexed at server level and reported as undiscovered.
      probeMcpTools: async (serverName) => {
        const result = await mcpUseCases.testConnection(serverName);
        return result.ok ? result.tools : undefined;
      },
      // Wrapped so a version's system prompt — the same text on every run of
      // that version — is embedded once per process rather than once per run.
      // Only queries are cached; a reindex's documents pass straight through.
      //
      // The space a cached vector belongs to is the model *and*, for the
      // OpenAI-compatible adapter, the endpoint it resolves from runtime
      // settings — which an admin can repoint without restarting anything. Both
      // reads are already cached where they live, so this costs nothing per
      // call and makes a repoint a cache miss instead of a wrong answer.
      embeddings: cacheQueryEmbeddings(
        EMBEDDINGS[config.embeddingProvider],
        config.embeddingProvider === "openai"
          ? async () => `${(await getLlmChannelConfig()).baseUrl}|${config.embeddingModel}`
          : () => config.embeddingModel,
      ),
      catalog: createS3VectorsStore(vectorBucket, config.catalogIndexName),
      minScore: config.catalogMinScore,
    }
  : undefined;
export const pluginUseCases = createPluginUseCases(pluginRepository);
/**
 * The project slice, which route handlers used to compose for themselves:
 * twenty of them imported `projectRepository` from here to hand it straight
 * back to a use case. Composed once now, like every other slice.
 */
export const projectUseCases = createProjectUseCases(projectRepository);
// `getMemberTier` is the issuance gate's tier source: a token may only exist
// for an owner whose tier allows one, and the same resolver answers the
// authentication-time check in `executionAuth.ts`.
export const apiTokenUseCases = createApiTokenUseCases(projectRepository, secretCipher, getMemberTier);
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
 * Pull the Agent Plugins repo and sync every plugin's skills and MCP servers.
 * Assembled here so the route never holds a repository — it only decides how
 * failures map to status codes. The caller passes the config it already
 * resolved: reading it again here would be a second settings load, and one
 * that can straddle the cache TTL and pick a different repo than the caller's
 * own guard checked. Servers go through `mcpUseCases` so a synced entry faces
 * the same URL guard a typed one does.
 */
/** How long a crashed sync may hold the door shut. Syncs finish in seconds. */
const PLUGIN_SYNC_LEASE_MS = 5 * 60_000;

export const syncPluginsFromRepo = async (
  repoConfig: Awaited<ReturnType<typeof getPluginsRepoConfig>>,
  actorEmail: string,
  selection?: PluginSyncSelection,
) => {
  const repo = repoConfig.repo ?? "";
  // One sync per repo at a time: a second one would double every GitHub read
  // and leave two contradicting reports.
  const lease = await pluginSyncLock.acquire(repo, PLUGIN_SYNC_LEASE_MS);
  if (!lease) {
    throw new ConflictError("A plugins sync is already running; wait for it to finish.");
  }
  try {
    const { fetchPluginsRepoSnapshot } = await import("@/infrastructure/github/pluginsRepoClient");
    const result = await syncPluginsFromSnapshot(
      {
        plugins: pluginRepository,
        pluginRows: pluginUseCases,
        skillRepo: skillRepository,
        skills: skillUseCases,
        mcps: mcpUseCases,
        ...(managedMcpUseCases ? { managedMcps: managedMcpUseCases } : {}),
        findBindings: (skills, mcpServers) =>
          findRegistryBindings(
            { projects: projectRepository, versions: versionRepository },
            skills,
            mcpServers,
          ),
      },
      await fetchPluginsRepoSnapshot(repoConfig),
      actorEmail,
      selection,
    );
    // The report outlives the browser that requested the sync — reloads and
    // load-balancer timeouts must not lose the only copy of what happened.
    await pluginSyncReportRepository.put({
      repo,
      report: result,
      actorEmail,
      finishedAt: new Date().toISOString(),
    });
    reindexAfterSync();
    return result;
  } finally {
    await pluginSyncLock.release(repo, lease);
  }
};

/**
 * Refresh the capability catalog once a sync has applied the repository.
 *
 * The catalog is otherwise rebuilt only by its own hourly tick, and a sync is
 * the single event that moves the most of it at once — a merge to the plugins
 * repo can add, rename or retire a dozen skills and servers together. Waiting
 * up to an hour to notice would mean a run discovering a skill the registry no
 * longer has, or missing one it just gained.
 *
 * This is the one exception to "indexing is never hooked to a write", and the
 * difference is what a failure would cost. Hanging it off a single registry
 * save would make an operator's 200 depend on an embedding call; here the sync
 * has already committed, its report is already persisted, and a failed reindex
 * changes none of that — the next tick repairs it. So the failure is logged and
 * swallowed rather than raised.
 *
 * Also the only way a **local** deployment refreshes at all: there is no
 * CronJob outside the cluster, so `pnpm` a sync and the index follows.
 *
 * **Scheduled, not awaited**, which is why this returns `void` rather than a
 * promise — an `await` on it would be a no-op, and the signature is what says
 * so. A reindex probes every registered MCP server, embeds the whole registry
 * and rewrites the index; awaiting it put all of that between the admin pressing
 * Sync and their answer, on a deployment that has already lost a response to a
 * 60-second proxy idle timeout — for work whose outcome that answer does not
 * depend on. It also ran *inside* `pluginSyncLock`'s five-minute lease, so a
 * slow one could outlive the lease, let a second sync acquire it, and then have
 * the first release someone else's. Deferring past the response fixes both: the
 * `finally` below releases the lease before this callback is ever entered.
 */
const reindexAfterSync = (): void => {
  if (!catalogDeps) {
    return;
  }
  const deps = catalogDeps;
  try {
    after(async () => {
      try {
        const { reindexCatalog } = await import("@/application/catalog/reindexCatalog");
        const report = await reindexCatalog(deps);
        log.info(
          "catalog",
          `reindex after plugins sync: indexed=${report.indexed} removed=${report.removed}` +
            ` undiscovered=${report.undiscovered.length}`,
        );
      } catch (error) {
        log.warn("catalog", "reindex after plugins sync failed; the hourly tick will repair it", error);
      }
    });
  } catch (error) {
    // `after` throws outside a request scope. Both callers are route handlers,
    // so this is the caller that does not exist yet — and it must not be the
    // thing that fails a sync which has already committed and reported.
    log.warn("catalog", "could not schedule a reindex after the sync; the hourly tick will do it", error);
  }
};

/** The persisted last report for the configured repo, for the console. */
export const lastPluginSync = (repo: string) => pluginSyncReportRepository.get(repo);

/** The branch head alone — what the tick compares before paying for a snapshot. */
export const pluginsRepoHeadSha = async (
  repoConfig: Awaited<ReturnType<typeof getPluginsRepoConfig>>,
) => {
  const { fetchRepoHeadSha } = await import("@/infrastructure/github/pluginsRepoClient");
  return fetchRepoHeadSha(repoConfig);
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

/**
 * The Slack workspace reads a run's tools are served from.
 *
 * Deferred per call like `slackAuthTest` above rather than imported at module
 * scope, and for the same reason: `executionDeps` is reached by every route
 * that runs anything, and a static import here would pull the Slack client into
 * all of them for a capability almost no run has switched on.
 */
const slackReader: SlackReaderPort = {
  channelHistory: async (token, args) =>
    (await import("@/infrastructure/slack/client")).slackClient.channelHistory(token, args),
  threadReplies: async (token, args) =>
    (await import("@/infrastructure/slack/client")).slackClient.threadReplies(token, args),
  listChannels: async (token, args) =>
    (await import("@/infrastructure/slack/client")).slackClient.listChannels(token, args),
  userProfile: async (token, userId) =>
    (await import("@/infrastructure/slack/client")).slackClient.userProfile(token, userId),
  userDetail: async (token, userId) =>
    (await import("@/infrastructure/slack/client")).slackClient.userDetail(token, userId),
  userEmail: async (token, userId) =>
    (await import("@/infrastructure/slack/client")).slackClient.userEmail(token, userId),
  findUsers: async (token, query, maxPages) =>
    (await import("@/infrastructure/slack/client")).slackClient.findUsers(token, query, maxPages),
  messageReactions: async (token, args) =>
    (await import("@/infrastructure/slack/client")).slackClient.messageReactions(token, args),
};

/**
 * Slack profile lookup (cached) for putting a name on a `slack:` usage row.
 * Module-local like `slackAuthTest`: `usageUseCases` below is the only
 * consumer now, and the actors route used to import this alongside the cipher
 * to assemble the read's dependencies itself.
 */
const slackUserProfile = async (botToken: string, userId: string) =>
  (await import("@/infrastructure/slack/client")).slackClient.userProfile(botToken, userId);

/** Usage reads: the dashboard summary and the owner-gated per-caller breakdown. */
export const usageUseCases = createUsageUseCases({
  usage: usageRepository,
  projects: projectRepository,
  // Token resolution closed over here: which token a project reads with is the
  // slack slice's knowledge, and the usage slice takes a bound reader instead
  // of the cipher-and-resolver pair it used to import for itself.
  profileReaderFor: (project) => {
    const runtime = resolveProjectSlackRuntime(secretCipher, project);
    return runtime ? (userId) => slackUserProfile(runtime.botToken, userId) : null;
  },
});

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

export const createProjectWithInitialVersion = composeCreateProjectWithInitialVersion({
  versions: versionRepository,
  projects: projectRepository,
  refs: versionRefRepos,
  cipher: secretCipher,
  // Which model fits which project type is the flow's policy; this only feeds
  // it the runtime settings the application layer may not read.
  offered: async () => {
    const [providers, enabled] = await Promise.all([getLlmProviderConfigs(), getEnabledModels()]);
    return offeredModels(
      providers.map((provider) => provider.name),
      enabled,
    );
  },
});

/**
 * Trace reads, authorization included. The two trace routes used to import the
 * repository and run the ownership check themselves — the presentation layer
 * deciding which store a trace is read from, and re-deriving who may see it.
 * Reads go to the plain repository: the OTLP export wrapper above only matters
 * to writes.
 */
export const traceUseCases = createTraceUseCases({
  traces: traceRepository,
  projects: projectRepository,
});

/** Readiness snapshot for the /api/ready probe (DynamoDB + LLM channel). */
export const readinessReport = () =>
  checkReadiness({ checkDb: dbReachable, checkLlm: () => llmReachable(getLlmChannelConfig) });

/**
 * Per-caller concurrency ceilings. Read once here rather than at each guard
 * call: the numbers come from boot env, and a getter per run would re-parse
 * them on every request.
 */
const concurrencyLimits: ConcurrencyLimits = {
  perActor: config.maxConcurrentRunsPerActor,
  a2a: config.maxConcurrentRunsA2a,
};

/**
 * The member tier behind an actor, for the run bracket's tier policies. Only
 * a `user` actor resolves one — machine callers *and project tokens* answer
 * `undefined` and keep the deployment-wide limits: a token is a service
 * credential bounded by its project, and whether a tier may hold one at all
 * is decided where the bearer token authenticates. A missing row still
 * answers the default tier rather than none: a `user` email exists by signing
 * in, so "no row" is the degenerate case, not the machine one.
 */
const actorTierResolver = async (actor: RunActor): Promise<MemberTier | undefined> => {
  const email = memberEmailFromActorKey(actorKey(actor));
  if (!email) {
    return undefined;
  }
  return (await getMemberTier(email)) ?? DEFAULT_MEMBER_TIER;
};

/**
 * The cost guard's threshold notification, token resolution included — the
 * guard takes one closure so the usage slice never imports the slack slice's
 * resolver. The client stays deferred, like every other Slack use here, so a
 * route that only wanted a repository does not load it.
 */
const postCostAlert: PostCostAlert = async (project, args) => {
  const runtime = resolveProjectSlackRuntime(secretCipher, project);
  if (!runtime) {
    return false;
  }
  await (await import("@/infrastructure/slack/client")).slackClient.postMessage(
    runtime.botToken,
    args,
  );
  return true;
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
  http: httpResourceReader,
  // The same adapter the chat routes wire: an attachment and a fetched page
  // become text the same way, which is what keeps one owner for extraction.
  documents: documentExtractor,
  // Bound here because deciding *which* workspace a project reads means
  // decrypting its bot token, which is the Slack slice's knowledge — the
  // execution slice takes the finished reader instead.
  slackWorkspace: (project) => {
    const runtime = resolveProjectSlackRuntime(secretCipher, project);
    return runtime ? createSlackWorkspaceReader(slackReader, runtime.botToken) : null;
  },
  remoteAgents,
  mcpSessions,
  mcpAuth: mcpAuthProvider,
  mcpConnections: mcpConnectionRepository,
  // The same bag the reindex uses — see {@link catalogDeps}.
  ...(catalogDeps ? { catalog: catalogDeps } : {}),
  internalHostSuffixes: config.mcpInternalHostSuffixes,
  traces: runTraceRepository,
  traceSampleRate: config.traceSampleRate,
  postAlert: postCostAlert,
  runSlots: runSlotRepository,
  limits: concurrencyLimits,
  unknownModelPolicy: getUnknownModelPolicy,
  resolveActorTier: actorTierResolver,
  ...(artifactStorage ? { artifacts: artifactStorage } : {}),
};

/**
 * Dependencies for image-generation projects.
 *
 * The same bag, not a second copy of it. `ExecutionDeps` already satisfies
 * `ImageGenerationDeps`, and the seven run-bracket fields were written out twice
 * — which the wiring test could not see, because it asks whether each optional
 * field is named *anywhere* in this file. So the next policy added to the
 * bracket would have reached `/predict`'s image path and nothing else, with the
 * test green. This narrows the declared type without restating the value.
 */
export const imageDeps: ImageGenerationDeps = executionDeps;

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
