import type { McpServer, McpTool } from "@/domain/mcp/types";
import type {
  CreateManagedInput,
  ManagedMcpStatus,
  UpdateManagedInput,
} from "@/application/mcp/managedMcpUseCases";
import type { DiscoverAuthResult } from "@/application/mcp/mcpAuthUseCases";
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

export type { DiscoverAuthResult };

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

export function saveMcpOAuthClient(
  name: string,
  input: { clientId?: string; clientSecret?: string; redirectUri?: string },
): Promise<McpServer> {
  return fetch(`/api/mcps/${name}/auth`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  }).then((r) => readJson<McpServer>(r));
}

// --- managed servers ---------------------------------------------------------

/**
 * A managed entry names an image, never a url: the address is written by the
 * provisioner once the container is listening, and cannot be typed.
 */
export type CreateManagedMcpInput = CreateManagedInput;
export type UpdateManagedMcpInput = UpdateManagedInput;

/**
 * Taken from the use case that answers with it rather than restated here: a
 * type-only import is erased, so the browser bundle is unchanged and the two
 * ends of the wire cannot drift.
 */
export type { ManagedMcpStatus };

export function createManagedMcp(input: CreateManagedMcpInput): Promise<McpServer> {
  return fetch("/api/mcps/managed", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  }).then((r) => readJson<McpServer>(r));
}

export function updateManagedMcp(
  name: string,
  input: UpdateManagedMcpInput,
): Promise<McpServer> {
  return fetch(`/api/mcps/managed/${name}`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  }).then((r) => readJson<McpServer>(r));
}

export function getManagedMcpStatus(name: string): Promise<ManagedMcpStatus> {
  return fetch(`/api/mcps/managed/${name}`).then((r) => readJson<ManagedMcpStatus>(r));
}

/**
 * Asks for the container to be re-created against the network namespace this
 * app has now. The entry keeps its address: the port is derived from the name.
 *
 * Resolves when the restart is accepted, not when it is finished — it runs for
 * as long as pulling an image takes. Poll `getManagedMcpStatus` for the outcome.
 */
/**
 * Queues a restart; the work outlives the response, so watch `status` for the
 * outcome. A 409 means one was already in flight — for a caller that is about
 * to watch the container that is the situation it asked for, not an error.
 */
export async function restartManagedMcp(name: string): Promise<void> {
  const res = await fetch(`/api/mcps/managed/${name}/restart`, { method: "POST" });
  if (res.status === 409) {
    return;
  }
  await assertOk(res);
}

/** Removes the container and the entry together. */
export function removeManagedMcp(name: string): Promise<void> {
  return fetch(`/api/mcps/managed/${name}`, { method: "DELETE" }).then(assertOk);
}
