/**
 * A configured value, or `undefined` when it carries nothing usable.
 *
 * Every optional env read here already treated the empty string as unset — `||
 * undefined` was the shape it took — because a variable that is not set and one
 * set to nothing mean the same thing to a deployment. Whitespace is that same
 * intent and was getting the opposite answer: `A2A_API_KEY=" "` passed the boot
 * guard, read as `source: "env"` on the settings page, and then failed every
 * request that presented it. Mounting a secret from a file is the ordinary way
 * to arrive there, since the file carries a trailing newline a header never can
 * — which `SCHEDULE_SCAN_TOKEN` had already discovered and trimmed on its own.
 *
 * The value is trimmed, not just tested, so a token with a trailing newline is
 * compared as the token.
 *
 * Deliberately not applied to the `??`-defaulted reads (`STAGE`,
 * `AWS_REGION`): those never decided that blank means
 * unset, and for `STAGE` the current answer is the safe one — an empty value
 * throws, where falling back to `local` would skip `assertAccessControlConfig`
 * on a deployed stage.
 */
export function optionalEnv(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}
