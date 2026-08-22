/**
 * Agent Card construction for projects exposed over A2A.
 * Cards are served at `/api/a2a/<project>/.well-known/agent-card.json` and
 * advertise the JSON-RPC endpoint at `/api/a2a/<project>`.
 */

import type { AgentCard } from "@a2a-js/sdk";
import type { Project, Version } from "@/domain/project/types";
import { buildPublicUrl } from "@/lib/public-url";

/** Spec version implemented by @a2a-js/sdk 0.3.x. */
const A2A_PROTOCOL_VERSION = "0.3.0";
const IMAGE_MODES = ["image/png", "image/jpeg", "image/webp"];
const OUTPUT_MODES: Record<Project["projectType"], string[]> = {
  llm: ["text/plain"],
  image: IMAGE_MODES,
  agent: ["text/plain", ...IMAGE_MODES],
};
/**
 * What a message to this agent may carry. A text or agent project runs a
 * model that may read a picture; an image project takes a prompt.
 */
const INPUT_MODES: Record<Project["projectType"], string[]> = {
  llm: ["text/plain", ...IMAGE_MODES],
  image: ["text/plain"],
  agent: ["text/plain", ...IMAGE_MODES],
};
/**
 * The credential the endpoint requires, declared where a client looks for
 * it. A client that attaches credentials from `card.security` sent nothing
 * while this was missing and was refused every call.
 */
const SECURITY_SCHEME = "a2aKey";

export async function buildProjectA2aRpcUrl(projectName: string): Promise<string> {
  return buildPublicUrl(`/api/a2a/${encodeURIComponent(projectName)}`);
}

export async function buildProjectAgentCardUrl(projectName: string): Promise<string> {
  return `${await buildProjectA2aRpcUrl(projectName)}/.well-known/agent-card.json`;
}

export async function buildAgentCard(project: Project, version: Version): Promise<AgentCard> {
  const rpcUrl = await buildProjectA2aRpcUrl(project.name);
  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: project.displayName || project.name,
    description: project.description,
    version: version.versionName,
    url: rpcUrl,
    preferredTransport: "JSONRPC",
    additionalInterfaces: [{ transport: "JSONRPC", url: rpcUrl }],
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: INPUT_MODES[project.projectType],
    defaultOutputModes: OUTPUT_MODES[project.projectType],
    securitySchemes: {
      [SECURITY_SCHEME]: { type: "apiKey", in: "header", name: "X-A2A-Key" },
    },
    security: [{ [SECURITY_SCHEME]: [] }],
    skills: [
      {
        id: project.name,
        name: project.name,
        description: project.description,
        tags: ["agent-studio", project.projectType],
      },
    ],
  };
}
