/**
 * Whether a run may execute a model the registry does not know.
 *
 * An unregistered id still dispatches — the channel takes any string — but
 * `calculateCost` has no pricing for it and books the call at **$0**. Inside a
 * company that is a corrupted dashboard; where the usage rows become an invoice
 * it is revenue leaking through the one report that would have shown it. The
 * default therefore stays `allow`, byte-identical to the behaviour every
 * existing deployment has, and a deployment that bills for its runs can choose
 * `refuse` instead.
 *
 * The check belongs to the run bracket, which is the only point all four
 * admitting functions pass through. Putting it in the execution facade would
 * miss image runs entirely, since `generateImage` never enters one.
 *
 * The bracket is not, however, the whole set of paths that spend money. A
 * subagent transfer never opens one — by design, since it is not a top-level run
 * — yet it dispatches to the provider and books a usage row exactly as its
 * parent does, and the parent's model being registered says nothing about the
 * child's. `agentBindings` applies this where the child's version resolves, for
 * that reason and no other.
 *
 * It is *not* attached to saving a version. Storing an id the registry has not
 * caught up with is how a new model gets adopted; the warning there already says
 * so. What this bounds is spending money under an id nothing can price.
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
