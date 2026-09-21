/** Fixed model fixtures for cost, capability and dispatch regression tests. Never shipped to the app. */
import snapshot from "./fixtures/modelRegistry.json";
import { replaceModelRegistry, modelType, type ModelConfig } from "@/domain/llm/models";
export { snapshot };
export function resetTestModels(): void { replaceModelRegistry(snapshot.models, snapshot.updatedAt); }
export function addTestModels(models: ModelConfig[]): void {
  const ids = new Set(models.map(model => model.id));
  replaceModelRegistry([...snapshot.models.filter(model => !ids.has(model.id)), ...models]);
}
export function loadTestCatalog(catalog: { models: ModelConfig[]; updatedAt?: string }): void {
  replaceModelRegistry(catalog.models, catalog.updatedAt);
}

export function fixtureRegistrations() {
  return snapshot.models.map(model => ({ ...model, wireId: "wireId" in model ? model.wireId as string : model.family, type: modelType(model) }));
}
