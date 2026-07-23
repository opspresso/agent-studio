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
import { channel } from "@/infrastructure/llm/channel";
import { imageChannel } from "@/infrastructure/llm/imageChannel";
import { traceRepository } from "@/infrastructure/db/repositories/traceRepository";

export { projectRepository, versionRepository, traceRepository };

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
