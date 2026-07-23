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
    capabilities: { streaming: true },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [
      {
        id: project.name,
        name: project.name,
        description: project.description,
        tags: [],
      },
    ],
  };
}
