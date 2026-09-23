import { ConflictError, NotFoundError, UpstreamError, ValidationError } from "@/application/errors";
import { auditTarget, recordAudit } from "@/application/audit/recordAudit";
import {
  MAX_REGISTERED_MODELS, registeredModelProblem,
  type ProviderModelDiscovery, type RegisteredModel,
} from "@/domain/llm/providerModels";
import type { SettingsRepository } from "@/domain/settings/repository";
import type { AppSettings, ProviderChannelConfig } from "@/domain/settings/types";

export interface ModelRegistryDeps {
  repository: SettingsRepository;
  discovery: ProviderModelDiscovery;
  providers(): Promise<ProviderChannelConfig[]>;
  /** Refresh effective runtime models after a committed write. */
  changed(): Promise<void>;
}

function usage(settings: AppSettings, id: string): string[] {
  return [
    ...(settings.defaultModel === id ? ["default"] : []),
    ...(settings.embeddingModel === id ? ["embedding"] : []),
    ...(settings.rerankerModel === id ? ["rerank"] : []),
    ...(settings.decisionModel === id ? ["decision"] : []),
    ...Object.entries(settings.workspaceModels ?? {}).filter(([, model]) => model === id).map(([runtime]) => runtime),
  ];
}

export function createModelRegistryUseCases(deps: ModelRegistryDeps) {
  async function committed(actorEmail: string, detail: string) {
    await deps.changed();
    await recordAudit({ actorEmail, action: "settings.update", target: auditTarget("settings", "models"), detail });
  }
  return {
    async list(): Promise<RegisteredModel[]> {
      return (await deps.repository.get())?.registeredModels ?? [];
    },
    async discover(name: string) {
      const provider = (await deps.providers()).find((item) => item.name === name);
      if (!provider) throw new NotFoundError("Provider is not registered");
      try { return await deps.discovery.list(provider); }
      catch (error) { throw new UpstreamError(error instanceof Error ? error.message : "Provider discovery failed"); }
    },
    async save(input: RegisteredModel, actorEmail: string): Promise<RegisteredModel[]> {
      const problem = registeredModelProblem(input);
      if (problem) throw new ValidationError(problem);
      const providers = await deps.providers();
      const { after } = await deps.repository.update((stored) => {
        const settings = stored ?? { updatedAt: "" };
        const available = settings.llmProviders ?? providers;
        if (!available.some((provider) => provider.name === input.provider)) throw new ValidationError("Provider is not registered");
        const previous = settings.registeredModels ?? [];
        const existing = previous.find((model) => model.id === input.id);
        if (existing && usage(settings, input.id).length && (existing.type !== input.type || existing.capabilities.tools !== input.capabilities.tools)) {
          throw new ConflictError("Change model usage before changing the selected model's type or tool capability");
        }
        const models = existing ? previous.map((model) => model.id === input.id ? input : model) : [...previous, input];
        if (models.length > MAX_REGISTERED_MODELS) throw new ValidationError(`At most ${MAX_REGISTERED_MODELS} models may be registered`);
        return { ...settings, registeredModels: models, updatedAt: new Date().toISOString() };
      });
      await committed(actorEmail, "registeredModels");
      return after.registeredModels ?? [];
    },
    async remove(id: string, actorEmail: string): Promise<void> {
      await deps.repository.update((stored) => {
        if (!stored?.registeredModels?.some((model) => model.id === id)) throw new NotFoundError("Model is not registered");
        const used = usage(stored, id);
        if (used.length) throw new ConflictError(`Change model usage before deleting this model: ${used.join(", ")}`);
        return { ...stored, registeredModels: stored.registeredModels.filter((model) => model.id !== id), updatedAt: new Date().toISOString() };
      });
      await committed(actorEmail, "registeredModels");
    },
    async selectDefault(id: string, actorEmail: string): Promise<void> {
      const providers = await deps.providers();
      await deps.repository.update((stored) => {
        const model = stored?.registeredModels?.find((item) => item.id === id);
        if (!model || model.type !== "text" || !model.capabilities.tools) throw new ValidationError("Select a registered text model as the default");
        if (!(stored?.llmProviders ?? providers).some((item) => item.name === model.provider)) throw new ValidationError("Provider is not registered");
        return { ...stored, defaultModel: id, updatedAt: new Date().toISOString() };
      });
      await committed(actorEmail, "defaultModel");
    },
    async selectDecision(id: string | null, actorEmail: string): Promise<void> {
      const providers = await deps.providers();
      await deps.repository.update((stored) => {
        if (!stored) throw new ValidationError("Register a decision model before selecting one");
        if (id === null) {
          const { decisionModel: _, ...remaining } = stored;
          return { ...remaining, updatedAt: new Date().toISOString() };
        }
        const model = stored.registeredModels?.find((item) => item.id === id);
        if (!model || model.type !== "decisions") throw new ValidationError("Select a registered decisions model");
        const provider = (stored.llmProviders ?? providers).find((item) => item.name === model.provider);
        if (!provider || !["openrouter", "selfhosted"].includes(provider.kind ?? provider.name) || (provider.auth ?? "bearer") !== "bearer") {
          throw new ValidationError("The decision model needs an OpenRouter or System One provider with bearer authentication");
        }
        return { ...stored, decisionModel: id, updatedAt: new Date().toISOString() };
      });
      await committed(actorEmail, "decisionModel");
    },
  };
}
