import type { AgentProtocol, ExternalAgent } from "@/domain/agent/types";
import type { A2aProjectListItem, A2aProjectListView } from "@/app/api/a2a/route";
import { assertOk, jsonHeaders, readJson } from "@/app/_lib/httpClient";

// Server responses carry masked (length-preserving; 9–20 chars reveal 2 at
// each end, 21+ reveal 4) header values — never the full plaintext or ciphertext.
export type { AgentProtocol, ExternalAgent };

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

export function listAgents(): Promise<ExternalAgent[]> {
  return fetch("/api/agents").then((r) => readJson<ExternalAgent[]>(r));
}

export function getAgent(name: string): Promise<ExternalAgent> {
  return fetch(`/api/agents/${name}`).then((r) => readJson<ExternalAgent>(r));
}

export function createAgent(input: CreateAgentInput): Promise<ExternalAgent> {
  return fetch("/api/agents", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  }).then((r) => readJson<ExternalAgent>(r));
}

export function updateAgent(name: string, patch: UpdateAgentInput): Promise<ExternalAgent> {
  return fetch(`/api/agents/${name}`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify(patch),
  }).then((r) => readJson<ExternalAgent>(r));
}

export async function deleteAgent(name: string): Promise<void> {
  await assertOk(await fetch(`/api/agents/${name}`, { method: "DELETE" }));
}

export type { A2aProjectListItem, A2aProjectListView };

/** Published studio projects exposed over A2A (derived, not registered). */
export function listA2aProjects(): Promise<A2aProjectListView> {
  return fetch("/api/a2a").then((r) => readJson<A2aProjectListView>(r));
}

export function sendAgentMessage(name: string, message: string): Promise<string> {
  return fetch(`/api/agents/${name}/message`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ message }),
  })
    .then((r) => readJson<{ text: string }>(r))
    .then((data) => data.text);
}
