/**
 * Whether a selected model with unknown pricing may run. The domain owns
 * parsing; application/run/modelPolicy.ts enforces the policy before spending.
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
