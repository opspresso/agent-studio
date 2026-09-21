import type { RegisteredModel } from "@/domain/llm/providerModels";
import type { ModelRegistryResponse } from "@/app/api/models/registry/route";
import type { ModelDiscoveryResponse } from "@/app/api/models/discover/route";
import type { ModelStatusResponse } from "@/app/api/models/status/route";
import { assertOk, jsonHeaders, readJson } from "@/app/_lib/httpClient";

export async function listRegisteredModels(): Promise<RegisteredModel[]> {
  return (await readJson<ModelRegistryResponse>(await fetch("/api/models/registry"))).models;
}

export async function discoverProviderModels(provider: string) {
  return (await readJson<ModelDiscoveryResponse>(await fetch(`/api/models/discover?provider=${encodeURIComponent(provider)}`))).models;
}

export async function saveRegisteredModel(model: RegisteredModel): Promise<RegisteredModel[]> {
  return (await readJson<ModelRegistryResponse>(await fetch("/api/models/registry", {
    method: "POST", headers: jsonHeaders, body: JSON.stringify(model),
  }))).models;
}

export async function deleteRegisteredModel(id: string): Promise<void> {
  await assertOk(await fetch(`/api/models/registry?id=${encodeURIComponent(id)}`, { method: "DELETE" }));
}

export function checkRegisteredModel(id: string): Promise<ModelStatusResponse> {
  return fetch(`/api/models/status?id=${encodeURIComponent(id)}`).then(response => readJson<ModelStatusResponse>(response));
}
