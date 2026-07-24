import type { McpServer } from "@/domain/mcp/types";
import { assertOk, jsonHeaders, readJson } from "@/app/_lib/httpClient";

// Server responses carry masked (length-preserving; long values reveal first/last
// 2 chars) header values — never the full plaintext or ciphertext.
export type { McpServer };

export interface McpTool {
  name: string;
  description: string;
}

export interface CreateMcpInput {
  name: string;
  url: string;
  description?: string;
  headers: Record<string, string>;
}

export interface UpdateMcpInput {
  url?: string;
  description?: string;
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
