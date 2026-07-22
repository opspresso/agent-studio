/**
 * Agent Card construction for projects exposed over A2A.
 * Cards are served at `/api/a2a/<project>/.well-known/agent-card.json` and
 * advertise the JSON-RPC endpoint at `/api/a2a/<project>`.
 */

import type { AgentCard } from "@a2a-js/sdk";
import type { Project, Version } from "@/domain/project/types";
import { config } from "@/lib/config";

/** Spec version implemented by @a2a-js/sdk 0.3.x. */
const A2A_PROTOCOL_VERSION = "0.3.0";

export function buildProjectA2aRpcUrl(projectName: string): string {
  const base = (config.publicBaseUrl ?? "http://localhost:3000").replace(/\/+$/, "");
  return `${base}/api/a2a/${encodeURIComponent(projectName)}`;
}

export function buildAgentCard(project: Project, version: Version): AgentCard {
  const rpcUrl = buildProjectA2aRpcUrl(project.name);
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
