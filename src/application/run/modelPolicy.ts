/**
 * Enforce the deployment's pricing policy before a model spends budget.
 * The run bracket checks primary and fallback models; delegated Agents apply
 * the same policy when resolving their own settings inside the parent bracket.
 */

import { getModelConfig } from "@/domain/llm/models";
import { ValidationError } from "@/application/errors";
import type { UnknownModelPolicy } from "@/domain/settings/modelPolicy";

export type { UnknownModelPolicy };

/** Every primary and fallback must be selected. The pricing policy can additionally refuse unknown rates. */
export function assertModelsPriceable(
  policy: UnknownModelPolicy,
  models: { model: string; fallbackModel?: string },
): void {
  const unknown = [models.model, models.fallbackModel].filter(
    (id): id is string => Boolean(id) && !getModelConfig(id as string),
  );
  if (unknown.length > 0) {
    throw new ValidationError(
      `Models must be selected by an administrator before use: ${unknown.join(", ")}`,
    );
  }
  if (policy === "refuse") {
    const unpriced = [models.model, models.fallbackModel].filter(id => id && getModelConfig(id)?.pricingKnown === false);
    if (unpriced.length) throw new ValidationError(`Model pricing is not configured: ${unpriced.join(", ")}`);
  }
}
