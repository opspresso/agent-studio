import type { McpRepository } from "@/domain/mcp/repository";
import type { McpRuntime, McpServer, McpServerAuth } from "@/domain/mcp/types";
import { createKeyedRepository } from "../keyedRepository";
import { keys } from "../keys";

const ENTITY_TYPE = "MCP" as const;

function fromItem(item: Record<string, unknown>): McpServer {
  return {
    name: item.name as string,
    url: item.url as string,
    // Absent on every row written before managed servers existed, which reads
    // back as `remote` — the shape those rows have always had.
    runtime: item.runtime as McpRuntime | undefined,
    image: item.image as string | undefined,
    envRefs: item.envRefs as string[] | undefined,
    containerPort: item.containerPort as number | undefined,
    description: item.description as string | undefined,
    content: item.content as string | undefined,
    headers: (item.headers as Record<string, string> | undefined) ?? {},
    auth: item.auth as McpServerAuth | undefined,
    createdAt: item.createdAt as string,
    updatedAt: item.updatedAt as string,
  };
}

function toItem(server: McpServer): Record<string, unknown> {
  return {
    ...keys.mcp(server.name),
    GSI1PK: keys.typePartition(ENTITY_TYPE),
    GSI1SK: server.name,
    entityType: ENTITY_TYPE,
    name: server.name,
    url: server.url,
    // Managed only. `runtime` is what earns a loopback address its trust, so it
    // has to survive the round trip or the entry silently becomes remote.
    runtime: server.runtime,
    image: server.image,
    envRefs: server.envRefs,
    // The only record of what the operator typed; a restart rebuilds the spec
    // from this row and has nowhere else to read it.
    containerPort: server.containerPort,
    description: server.description,
    content: server.content,
    headers: server.headers,
    // Absent for a static-header server; `clearAuth` relies on writing it away.
    auth: server.auth,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
  };
}

export const mcpRepository: McpRepository = createKeyedRepository<McpServer>({
  entityType: ENTITY_TYPE,
  key: keys.mcp,
  toItem,
  fromItem,
});
