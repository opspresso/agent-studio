export type AgentProtocol = "openai" | "a2a";

export interface ExternalAgent {
  name: string;
  url: string;
  protocol?: AgentProtocol;
  description: string;
  /** Masked (`********`) header values — never plaintext or ciphertext. */
  headers: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAgentInput {
  name: string;
  url: string;
  protocol?: AgentProtocol;
  description: string;
  headers: Record<string, string>;
}

export interface UpdateAgentInput {
  url?: string;
  protocol?: AgentProtocol;
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

export function listAgents(): Promise<ExternalAgent[]> {
  return fetch("/api/agents").then((r) => readJson<ExternalAgent[]>(r));
}

export function getAgent(name: string): Promise<ExternalAgent> {
  return fetch(`/api/agents/${name}`).then((r) => readJson<ExternalAgent>(r));
}

export function createAgent(input: CreateAgentInput): Promise<ExternalAgent> {
  return fetch("/api/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).then((r) => readJson<ExternalAgent>(r));
}

export function updateAgent(name: string, patch: UpdateAgentInput): Promise<ExternalAgent> {
  return fetch(`/api/agents/${name}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  }).then((r) => readJson<ExternalAgent>(r));
}

export async function deleteAgent(name: string): Promise<void> {
  const res = await fetch(`/api/agents/${name}`, { method: "DELETE" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
}

export function sendAgentMessage(name: string, message: string): Promise<string> {
  return fetch(`/api/agents/${name}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  })
    .then((r) => readJson<{ text: string }>(r))
    .then((data) => data.text);
}
