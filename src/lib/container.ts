/**
 * Composition root. Wires domain repository ports to their DynamoDB adapters and
 * exposes the `executionDeps` bundle consumed by the execution facade
 * (`@/application/execution/runProject`). Route handlers and pages import repos
 * and deps from here — never from `infrastructure/` directly.
 */

import { projectRepository } from "@/infrastructure/db/repositories/projectRepository";
import { versionRepository } from "@/infrastructure/db/repositories/versionRepository";
import { skillRepository } from "@/infrastructure/db/repositories/skillRepository";
import { mcpRepository } from "@/infrastructure/db/repositories/mcpRepository";
import { externalAgentRepository } from "@/infrastructure/db/repositories/externalAgentRepository";
import { usageRepository } from "@/infrastructure/db/repositories/usageRepository";
import { createChannel } from "@/infrastructure/llm/channel";
import { createImageChannel } from "@/infrastructure/llm/imageChannel";
import { resolveProviderTarget } from "@/infrastructure/llm/providers";
import { traceRepository } from "@/infrastructure/db/repositories/traceRepository";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import { urlPolicy } from "@/infrastructure/net/urlPolicy";
import { settingsRepository } from "@/infrastructure/db/repositories/settingsRepository";
import { createA2aTaskStore } from "@/infrastructure/a2a/taskStore";
import { dbReachable, llmReachable } from "@/infrastructure/health/probes";
import { fetchSkillsRepoSnapshot } from "@/infrastructure/github/skillsRepoClient";
import { checkReadiness } from "@/application/health/readiness";
import { createAgentUseCases } from "@/application/agent/agentUseCases";
import { createMcpUseCases } from "@/application/mcp/mcpUseCases";
import { createSkillUseCases } from "@/application/skill/skillUseCases";
import { createSettingsUseCases } from "@/application/settings/settingsUseCases";
import { syncSkillsFromSnapshot } from "@/application/skill/syncSkills";
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
};

/**
 * Registry slice singletons. Each slice exports only its `createXUseCases`
 * factory; the instance is composed here so a repository or port implementation
 * has exactly one wiring site.
 */
export const agentUseCases = createAgentUseCases(externalAgentRepository, secretCipher, urlPolicy);
export const mcpUseCases = createMcpUseCases(mcpRepository, secretCipher, urlPolicy);
export const skillUseCases = createSkillUseCases(skillRepository);
export const settingsUseCases = createSettingsUseCases(settingsRepository, secretCipher, process.env);

/**
 * Pull the skills repo and upsert every SKILL.md. Assembled here so the route
 * never holds a repository — it only decides how failures map to status codes.
 */
export const syncSkillsFromRepo = async () =>
  syncSkillsFromSnapshot(
    skillRepository,
    await fetchSkillsRepoSnapshot(await getSkillsRepoConfig()),
  );

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
