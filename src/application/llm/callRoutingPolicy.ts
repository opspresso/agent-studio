import { isCallRoutingPolicy, type CallRoutingPolicy } from "@/domain/llm/callRouting";
import { modelType, type ModelConfig } from "@/domain/llm/models";
import { ValidationError } from "@/application/errors";

/** Shared policy admission uses deployment registrations, never one Agent's choices. */
export function assertCallRoutingPolicy(policy: CallRoutingPolicy, models: readonly ModelConfig[]): void {
  if (!isCallRoutingPolicy(policy)) throw new ValidationError("Invalid model routing policy");
  const registered = new Map(models.map(model => [model.id, model]));
  for (const [tier, id] of Object.entries(policy.tiers)) {
    const model = registered.get(id);
    if (!model || model.hidden || modelType(model) !== "text") throw new ValidationError(`Routing model is not an available registered text model: ${id}`);
    if (model.pricingKnown === false) throw new ValidationError(`Routing model price is unknown: ${id}`);
    if (policy.localOnly && model.providerKind !== "selfhosted") throw new ValidationError(`Routing model violates self-hosted policy: ${id}`);
    if (tier === "reasoning" && !model.capabilities.reasoning || tier === "vision" && !model.capabilities.imageInput) throw new ValidationError(`Routing model does not support tier ${tier}: ${id}`);
  }
  for (const tier of Object.values(policy.policies)) {
    if (!policy.tiers[tier]) throw new ValidationError(`Routing policy tier has no model: ${tier}`);
  }
}
