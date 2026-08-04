/**
 * Whether a run may execute a model the registry cannot price.
 *
 * The value and its parsing live in the domain, one layer below the rule that
 * enforces them (`assertModelsPriceable`, in `application/execution`). They were
 * together in `application` and `src/lib/runtime-settings.ts` reached up for the
 * parser — the one place `lib` imported a use-case module. That direction had no
 * rule against it and no reason to exist: reading a stored string into the two
 * values it can mean is a fact about the setting, not a use case.
 */

export type UnknownModelPolicy = "allow" | "refuse";

/**
 * Read a stored or configured value. Anything unrecognised — an older row, a
 * hand-edited setting — resolves to `allow`, because a malformed policy must not
 * be the reason a deployment stops running.
 */
export function toUnknownModelPolicy(value: string | undefined): UnknownModelPolicy {
  return value?.trim().toLowerCase() === "refuse" ? "refuse" : "allow";
}
