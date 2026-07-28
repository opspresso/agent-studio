import type { CSSProperties } from "react";

/**
 * Marks an input whose value is read character by character rather than as
 * words: tokens, URLs, header values, model ids, markdown source.
 *
 * The one thing the old `formStyles.ts` owned that Mantine has no prop for.
 * Everything else that file defined — border, padding, focus ring, disabled
 * state — is now `theme.components`; this is the remainder, and it is here
 * rather than inline because twelve copies of it across nine files is how the
 * previous set of style constants started.
 */
export const monoInput: { input: CSSProperties } = {
  input: { fontFamily: "var(--mantine-font-family-monospace)" },
};
