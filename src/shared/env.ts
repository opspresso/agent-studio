/**
 * A configured value, or `undefined` when it carries nothing usable.
 *
 * Empty and whitespace-only values are unset. A mounted secret may carry a
 * trailing newline, so usable values are trimmed before display or comparison.
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
