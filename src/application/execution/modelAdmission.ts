/**
 * Whether a run may dispatch a model this app has never heard of.
 *
 * A model missing from `src/domain/llm/models.ts` runs perfectly well — the
 * provider knows it, this app does not — and its usage is booked at **$0**. On
 * an internal platform that corrupts a dashboard. Where the numbers are billed
 * on, it is revenue leaking through a gap nobody can see, because the miss is
 * invisible in exactly the report it spoils.
 *
 * So the behaviour stays the default and the *refusal* is the option: a
 * deployment that bills says `refuse`, and every other deployment dispatches
 * exactly what it did before. What `allow` costs is the policy read itself —
 * the composition root wires the reader unconditionally, so this runs on every
 * dispatch. That read is the same cached settings resolution the channel does
 * a moment later for the base URL and key, so on the hot path it is a map
 * lookup; the fast path below is for a caller that wired no reader at all.
 *
 * The check covers the fallback as well as the primary. A fallback is reached
 * on a retryable failure of the primary, which is to say at the worst possible
 * moment to discover that the run cannot be priced.
 */

import { getModelConfig } from "@/domain/llm/models";
import { ValidationError } from "@/application/errors";

export type UnknownModelPolicy = "allow" | "refuse";

export interface ModelAdmissionDeps {
  /**
   * Reads the deployment's policy. Absent means `allow` — an injection nobody
   * wired keeps the behaviour every existing deployment already has.
   */
  unknownModelPolicy?: () => Promise<UnknownModelPolicy>;
}

/** The models a run intends to dispatch, as the version declares them. */
export interface RunModels {
  model: string;
  fallbackModel?: string;
}

/** Refused before dispatch, so it is an ordinary 400 rather than a mid-stream error. */
export class UnknownModelError extends ValidationError {
  constructor(readonly modelIds: string[]) {
    super(
      `This deployment refuses models missing from its registry: ${modelIds.join(", ")}. ` +
        `Add them to the model registry, or pick a registered model.`,
    );
  }
}

/**
 * Throw when the policy is `refuse` and a model is unregistered.
 *
 * A policy read that fails is not a reason to refuse: the guard exists to
 * protect a billing figure, and turning a settings blip into a platform outage
 * trades a real problem for a worse one. It fails **open**, like the cost guard
 * and for the same reason.
 */
export async function assertModelsRunnable(
  deps: ModelAdmissionDeps,
  models: RunModels,
): Promise<void> {
  if (!deps.unknownModelPolicy) {
    return;
  }
  let policy: UnknownModelPolicy;
  try {
    policy = await deps.unknownModelPolicy();
  } catch {
    return;
  }
  if (policy !== "refuse") {
    return;
  }
  const unknown = [models.model, models.fallbackModel].filter(
    (id): id is string => !!id && !getModelConfig(id),
  );
  if (unknown.length > 0) {
    throw new UnknownModelError(unknown);
  }
}
