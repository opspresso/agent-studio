import type { AgentProtocol, ExternalAgent } from "@/domain/agent/types";
import type {
  CreateAgentInput,
  UpdateAgentInput,
} from "@/application/agent/agentUseCases";
// Each from the module that owns it: the item is the use case's, the list is
// the route's — it is the route that says whether the surface is enabled.
import type { A2aProjectListItem } from "@/application/a2a/exposure";
import type { A2aProjectListResponse } from "@/app/api/a2a/route";
import { assertOk, jsonHeaders, readJson } from "@/app/_lib/httpClient";

// Server responses carry masked (length-preserving, with four visible characters
// at each end above eight characters) header values — never the full plaintext or ciphertext.
export type { AgentProtocol, ExternalAgent };
export type { CreateAgentInput, UpdateAgentInput };

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

export type { A2aProjectListItem, A2aProjectListResponse };

/** Accessible configured Studio Agents available over A2A without registration. */
export function listA2aProjects(): Promise<A2aProjectListResponse> {
  return fetch("/api/a2a").then((r) => readJson<A2aProjectListResponse>(r));
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
