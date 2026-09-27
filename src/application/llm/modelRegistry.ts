import { ConflictError, NotFoundError, UpstreamError, ValidationError } from "@/application/errors";
import { auditTarget, recordAudit } from "@/application/audit/recordAudit";
import {
  MAX_REGISTERED_MODELS, providerKind, registeredModelId, registeredModelProblem,
  type ProviderModelDiscovery, type RegisteredModel,
  registeredModelConfig,
} from "@/domain/llm/providerModels";
import type { ModelPricing } from "@/domain/llm/models";
import type { SettingsRepository } from "@/domain/settings/repository";
import type { AppSettings, ProviderChannelConfig } from "@/domain/settings/types";
import { DEFAULT_CALL_ROUTING_POLICY, type CallRoutingPolicy } from "@/domain/llm/callRouting";
import { assertCallRoutingPolicy } from "./callRoutingPolicy";

export interface ModelRoutingView { policy: CallRoutingPolicy; configured: boolean; decisionModel: string | null }

function routingView(settings: AppSettings | null): ModelRoutingView {
  return { policy: structuredClone(settings?.modelRouting ?? DEFAULT_CALL_ROUTING_POLICY), configured: settings?.modelRouting !== undefined, decisionModel: settings?.decisionModel ?? null };
}

export interface ModelRegistryDeps {
  repository: SettingsRepository;
  discovery: ProviderModelDiscovery;
  providers(): Promise<ProviderChannelConfig[]>;
  catalogModelId(provider: Pick<ProviderChannelConfig, "name" | "kind">, wireId: string): string | undefined;
  catalogPricing(provider: Pick<ProviderChannelConfig, "name" | "kind">, wireId: string): ModelPricing | undefined;
  /** Refresh effective runtime models after a committed write. */
  changed(): Promise<void>;
}

export type RegisteredModelView = RegisteredModel & { pricingSource?: "catalog" };

function usage(settings: AppSettings, id: string): string[] {
  return [
    ...(settings.defaultModel === id ? ["default"] : []),
    ...(settings.embeddingModel === id ? ["embedding"] : []),
    ...(settings.rerankerModel === id ? ["rerank"] : []),
    ...(settings.decisionModel === id ? ["decision"] : []),
    ...Object.entries(settings.modelRouting?.tiers ?? {}).filter(([, model]) => model === id).map(([tier]) => `routing:${tier}`),
    ...Object.entries(settings.workspaceModels ?? {}).filter(([, model]) => model === id).map(([runtime]) => runtime),
  ];
}

export function createModelRegistryUseCases(deps: ModelRegistryDeps) {
  function views(models: RegisteredModel[], providers: Pick<ProviderChannelConfig, "name" | "kind">[]): RegisteredModelView[] {
    return models.map(model => {
      const provider = providers.find(item => item.name === model.provider);
      const pricing = provider && deps.catalogPricing(provider, model.wireId);
      return pricing ? { ...model, pricing, pricingSource: "catalog" } : model;
    });
  }
  async function committed(actorEmail: string, detail: string) {
    await deps.changed();
    await recordAudit({ actorEmail, action: "settings.update", target: auditTarget("settings", "models"), detail });
  }
  return {
    async getRouting(): Promise<ModelRoutingView> {
      return routingView(await deps.repository.get());
    },
    async saveRouting(policy: CallRoutingPolicy, actorEmail: string): Promise<ModelRoutingView> {
      const providers = await deps.providers();
      const { after } = await deps.repository.update((stored) => {
        const settings = stored ?? { updatedAt: "" };
        const connections = settings.llmProviders ?? providers;
        const models = (settings.registeredModels ?? []).flatMap(model => {
          const provider = connections.find(connection => connection.name === model.provider);
          if (!provider) return [];
          const pricing = deps.catalogPricing(provider, model.wireId) ?? model.pricing;
          return [registeredModelConfig({ ...model, ...(pricing ? { pricing } : {}) }, providerKind(provider))];
        });
        assertCallRoutingPolicy(policy, models);
        return { ...settings, modelRouting: structuredClone(policy), updatedAt: new Date().toISOString() };
      });
      await committed(actorEmail, "modelRouting");
      return routingView(after);
    },
    async list(): Promise<RegisteredModelView[]> {
      return views((await deps.repository.get())?.registeredModels ?? [], await deps.providers());
    },
    async discover(name: string) {
      const provider = (await deps.providers()).find((item) => item.name === name);
      if (!provider) throw new NotFoundError("Provider is not registered");
      try { return await deps.discovery.list(provider); }
      catch (error) { throw new UpstreamError(error instanceof Error ? error.message : "Provider discovery failed"); }
    },
    async save(input: RegisteredModel, actorEmail: string): Promise<RegisteredModelView[]> {
      const providers = await deps.providers();
      const { after } = await deps.repository.update((stored) => {
        const settings = stored ?? { updatedAt: "" };
        const available = settings.llmProviders ?? providers;
        const provider = available.find(item => item.name === input.provider);
        if (!provider) throw new ValidationError("Provider is not registered");
        const catalogId = deps.catalogModelId(provider, input.wireId);
        if (providerKind(provider) !== "selfhosted" && !catalogId) throw new ValidationError("Model is not in the published catalog");
        const expectedId = catalogId ?? registeredModelId(input.provider, input.wireId);
        const problem = registeredModelProblem(input, expectedId);
        if (problem) throw new ValidationError(problem);
        const previous = settings.registeredModels ?? [];
        const existing = previous.find((model) => model.id === input.id);
        if (existing && existing.provider !== input.provider) throw new ConflictError("Model ID already uses another provider connection");
        if (existing && usage(settings, input.id).length && (existing.type !== input.type || existing.capabilities.tools !== input.capabilities.tools)) {
          throw new ConflictError("Change model usage before changing the selected model's type or tool capability");
        }
        const saved = existing && deps.catalogPricing(provider, input.wireId)
          ? { ...input, pricing: existing.pricing }
          : input;
        const models = existing ? previous.map((model) => model.id === input.id ? saved : model) : [...previous, saved];
        if (models.length > MAX_REGISTERED_MODELS) throw new ValidationError(`At most ${MAX_REGISTERED_MODELS} models may be registered`);
        return { ...settings, registeredModels: models, updatedAt: new Date().toISOString() };
      });
      await committed(actorEmail, "registeredModels");
      return views(after.registeredModels ?? [], after.llmProviders ?? providers);
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
        if (!model || model.type !== "decision") throw new ValidationError("Select a registered decision model");
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
