export interface McpServer {
  name: string;
  url: string;
  description?: string;
  /** Masked (length-preserving asterisks) header values — never plaintext or ciphertext. */
  headers: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

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

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
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
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).then((r) => readJson<McpServer>(r));
}

export function updateMcp(name: string, patch: UpdateMcpInput): Promise<McpServer> {
  return fetch(`/api/mcps/${name}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  }).then((r) => readJson<McpServer>(r));
}

export async function deleteMcp(name: string): Promise<void> {
  const res = await fetch(`/api/mcps/${name}`, { method: "DELETE" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
}

export function testMcpConnection(name: string): Promise<McpTool[]> {
  return fetch(`/api/mcps/${name}/tools`, { method: "POST" })
    .then((r) => readJson<{ tools: McpTool[] }>(r))
    .then((data) => data.tools);
}
