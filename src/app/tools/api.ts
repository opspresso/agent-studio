import type { McpServer, McpTool } from "@/domain/mcp/types";
import { assertOk, jsonHeaders, readJson } from "@/app/_lib/httpClient";

// Server responses carry masked (length-preserving; 9–20 chars reveal 2 at
// each end, 21+ reveal 4) header values — never the full plaintext or ciphertext.
export type { McpServer, McpTool };

export interface CreateMcpInput {
  name: string;
  url: string;
  description?: string;
  content?: string;
  headers: Record<string, string>;
}

export interface UpdateMcpInput {
  url?: string;
  description?: string;
  content?: string;
  headers?: Record<string, string>;
}

export function listMcps(): Promise<McpServer[]> {
  return fetch("/api/mcps").then((r) => readJson<McpServer[]>(r));
}

export function getMcp(name: string): Promise<McpServer> {
  return fetch(`/api/mcps/${name}`).then((r) => readJson<McpServer>(r));
}

export function createMcp(input: CreateMcpInput): Promise<McpServer> {
  return fetch("/api/mcps", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  }).then((r) => readJson<McpServer>(r));
}

export function updateMcp(name: string, patch: UpdateMcpInput): Promise<McpServer> {
  return fetch(`/api/mcps/${name}`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify(patch),
  }).then((r) => readJson<McpServer>(r));
}

export async function deleteMcp(name: string): Promise<void> {
  await assertOk(await fetch(`/api/mcps/${name}`, { method: "DELETE" }));
}

export function testMcpConnection(name: string): Promise<McpTool[]> {
  return fetch(`/api/mcps/${name}/tools`, { method: "POST" })
    .then((r) => readJson<{ tools: McpTool[] }>(r))
    .then((data) => data.tools);
}

export type DiscoverAuthResult =
  | { status: "discovered"; auth: NonNullable<McpServer["auth"]> }
  | { status: "choose"; resource: string; authorizationServers: string[] };

/**
 * Read the server's published OAuth metadata and store it (admin-only). Pass an
 * authorization server to answer a previous `choose` result — the choice is the
 * client's to make when a resource advertises more than one.
 */
export function discoverMcpAuth(
  name: string,
  authorizationServer?: string,
): Promise<DiscoverAuthResult> {
  return fetch(`/api/mcps/${name}/auth`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(authorizationServer ? { authorizationServer } : {}),
  }).then((r) => readJson<DiscoverAuthResult>(r));
}

export async function clearMcpAuth(name: string): Promise<void> {
  await assertOk(await fetch(`/api/mcps/${name}/auth`, { method: "DELETE" }));
}
