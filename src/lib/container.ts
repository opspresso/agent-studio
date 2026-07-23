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

export { projectRepository, versionRepository };

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
};

/** Dependencies for image-generation projects. */
export const imageDeps = {
  imageChannel,
  usage: usageRepository,
};
