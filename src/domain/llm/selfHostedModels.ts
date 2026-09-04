/**
 * The shape of a self-hosted model declaration, and its two mappings: what an
 * operator states on the console form ↔ the full catalog-shaped entry the
 * registry overlay installs (`models.ts`'s `loadSelfHostedModels`).
 *
 * Its own file rather than a corner of `models.ts`, because the registry
 * module is under a stricter rule: it states no number of its own
 * (`tests/models.test.ts`), while a declaration constructor *must* state one —
 * the zero price that is a self-hosted route's defining fact.
 */

import { modelType, type ModelCapabilities, type ModelConfig, type ModelType } from "./models";

/** What an operator states about one self-hosted model — the declaration form. */
export interface SelfHostedModelInput {
  /** The serving stack's own model name, slashes included (`qwen/qwen3.8-27b`). */
  family: string;
  displayName: string;
  /** Defaults to the family's vendor segment when it has one, else `local`. */
  maker?: string;
  type: ModelType;
  contextWindow: number;
  maxTokens: number;
  capabilities: {
    tools: boolean;
    structuredOutput: boolean;
    imageInput: boolean;
    reasoning: boolean;
  };
}

/** A declaration in its stored, catalog-shaped form — what the overlay installs. */
export interface SelfHostedModelDeclaration {
  /** `selfhosted/<family>`. */
  id: string;
  provider: string;
  family: string;
  maker: string;
  displayName: string;
  /** Always zeros — running your own hardware bills no tokens. */
  pricing: { inputPer1M: number; outputPer1M: number };
  capabilities: ModelCapabilities;
  contextWindow: number;
  maxTokens: number;
}

/**
 * One declaration in its stored form: the full catalog-shaped entry, so a boot
 * or a refresh tick installs what is stored without re-deriving anything. The
 * maker defaults to the family's vendor segment — LM Studio ids carry one
 * (`qwen/qwen3.8-27b`) — else `local`; the pricing is always zeros, the one
 * price a self-hosted route is allowed to state.
 */
export function selfHostedModelFromInput(input: SelfHostedModelInput): SelfHostedModelDeclaration {
  const family = input.family.trim();
  const slash = family.indexOf("/");
  const maker = input.maker?.trim() || (slash > 0 ? family.slice(0, slash) : "local");
  const capabilities: ModelCapabilities = {
    ...(input.type === "text"
      ? input.capabilities
      : { tools: false, structuredOutput: false, imageInput: false, reasoning: false }),
    ...(input.type === "image" ? { imageGeneration: true } : {}),
    ...(input.type === "embedding" ? { embedding: true } : {}),
    ...(input.type === "rerank" ? { rerank: true } : {}),
    ...(input.type === "transcription" ? { transcription: true } : {}),
  };
  return {
    id: `selfhosted/${family}`,
    provider: "selfhosted",
    family,
    maker,
    displayName: input.displayName.trim(),
    pricing: { inputPer1M: 0, outputPer1M: 0 },
    capabilities,
    contextWindow: input.contextWindow,
    maxTokens: input.maxTokens,
  };
}

/** A declared entry back in the form's shape — what the console edits and resubmits. */
export function selfHostedModelToInput(model: ModelConfig): SelfHostedModelInput {
  return {
    family: model.family,
    displayName: model.displayName,
    maker: model.maker,
    type: modelType(model),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    capabilities: {
      tools: model.capabilities.tools,
      structuredOutput: model.capabilities.structuredOutput,
      imageInput: model.capabilities.imageInput,
      reasoning: model.capabilities.reasoning,
    },
  };
}

/** Replace the declaration for one served family, or append it when it is new. */
export function upsertSelfHostedModelInput(
  declarations: ModelConfig[],
  input: SelfHostedModelInput,
): SelfHostedModelInput[] {
  let replaced = false;
  const next = declarations.map((model) => {
    if (model.family !== input.family) {
      return selfHostedModelToInput(model);
    }
    replaced = true;
    return input;
  });
  return replaced ? next : [...next, input];
}
