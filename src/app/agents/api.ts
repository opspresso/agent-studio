import type { ExternalAgent } from "@/domain/agent/types";
import type {
  CreateAgentInput,
  UpdateAgentInput,
} from "@/application/agent/agentUseCases";
// Each from the module that owns it: the item is the use case's, the list is
// the route's — it is the route that says whether the surface is enabled.
import { assertOk, jsonHeaders, readJson } from "@/app/_lib/httpClient";

// Server responses carry masked (length-preserving, with four visible characters
// at each end above eight characters) header values — never the full plaintext or ciphertext.
export type { ExternalAgent };
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

export function sendAgentMessage(name: string, message: string): Promise<string> {
  return fetch(`/api/agents/${name}/message`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ message }),
  })
    .then((r) => readJson<{ text: string }>(r))
    .then((data) => data.text);
}
