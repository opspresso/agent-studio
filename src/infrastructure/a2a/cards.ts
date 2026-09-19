/**
 * Agent Card construction for projects exposed over A2A.
 * Cards are served at `/api/a2a/<project>/.well-known/agent-card.json` and
 * advertise the JSON-RPC endpoint at `/api/a2a/<project>`.
 */

import { A2A_PROTOCOL_VERSION, type AgentCard } from "@a2a-js/sdk";
import type { Project, Version } from "@/domain/project/types";
import { buildPublicUrl } from "@/lib/public-url";

const IMAGE_MODES = ["image/png", "image/jpeg", "image/webp"];
const MODES = ["text/plain", ...IMAGE_MODES];
/**
 * The credential the endpoint requires, declared where a client looks for
 * it. A client that attaches credentials from `securityRequirements` sent nothing
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
  const securityRequirements = [{ schemes: { [SECURITY_SCHEME]: { list: [] } } }];
  return {
    name: project.displayName || project.name,
    description: project.description,
    supportedInterfaces: [
      { url: rpcUrl, protocolBinding: "JSONRPC", tenant: "", protocolVersion: A2A_PROTOCOL_VERSION },
    ],
    provider: undefined,
    version: version.versionName,
    capabilities: { streaming: true, pushNotifications: false, extensions: [] },
    defaultInputModes: MODES,
    defaultOutputModes: MODES,
    securitySchemes: {
      [SECURITY_SCHEME]: {
        scheme: {
          $case: "apiKeySecurityScheme",
          value: { description: "Agent Studio A2A client key", location: "header", name: "X-A2A-Key" },
        },
      },
    },
    securityRequirements,
    skills: [
      {
        id: project.name,
        name: project.name,
        description: project.description,
        tags: ["agent-studio", project.projectType],
        examples: [],
        inputModes: MODES,
        outputModes: MODES,
        securityRequirements,
      },
    ],
    signatures: [],
  };
}
