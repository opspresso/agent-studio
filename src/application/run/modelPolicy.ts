/**
 * Enforce the deployment's pricing policy before a model spends budget.
 * The run bracket checks primary and fallback models; delegated Agents apply
 * the same policy when resolving their own settings inside the parent bracket.
 */

import { getModelConfig } from "@/domain/llm/models";
import { ValidationError } from "@/application/errors";
import type { UnknownModelPolicy } from "@/domain/settings/modelPolicy";

export type { UnknownModelPolicy };

/**
 * Refuse a run whose primary or fallback model is unregistered, when the
 * deployment asked to be refused.
 *
 * Both are checked because a fallback is not a lesser path: it carries the
 * whole run whenever the primary is rate-limited, and an unpriced fallback
 * leaks exactly as much as an unpriced primary — silently, and only under load.
 *
 * Throws before dispatch, so an SSE surface answers with an HTTP 400 rather
 * than a stream that opens and immediately says something went wrong (the
 * streaming routes pull the first chunk before constructing the response for
 * this reason).
 */
export function assertModelsPriceable(
  policy: UnknownModelPolicy,
  models: { model: string; fallbackModel?: string },
): void {
  if (policy !== "refuse") {
    return;
  }
  const unknown = [models.model, models.fallbackModel].filter(
    (id): id is string => Boolean(id) && !getModelConfig(id as string),
  );
  if (unknown.length > 0) {
    throw new ValidationError(
      `This deployment refuses models that are not in the registry, because their usage would be recorded at $0: ${unknown.join(", ")}`,
    );
  }
}
