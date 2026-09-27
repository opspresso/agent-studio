import type { CSSProperties } from "react";

/**
 * Marks an input whose value is read character by character rather than as
 * words: tokens, URLs, header values, model ids, markdown source.
 *
 * Opt in per input so ordinary prose fields keep the console's text font.
 */
export const monoInput: { input: CSSProperties } = {
  input: { fontFamily: "var(--mantine-font-family-monospace)" },
};
