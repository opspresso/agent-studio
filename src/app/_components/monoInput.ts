import type { CSSProperties } from "react";

/**
 * Marks an input whose value is read character by character rather than as
 * words: tokens, URLs, header values, model ids, markdown source.
 *
 * Here rather than in `theme.components` because Mantine has no prop for it, and
 * a named constant rather than inline because twelve copies across nine files is
 * how the previous set of style constants started.
 */
export const monoInput: { input: CSSProperties } = {
  input: { fontFamily: "var(--mantine-font-family-monospace)" },
};
