"use client";

/**
 * Colours a string when it turns out to be JSON, and leaves it alone when it
 * does not.
 *
 * The places this is for — a tool call's arguments, what the tool answered, the
 * schema list an Agent offers — carry text nobody here wrote: a provider's
 * argument object, an MCP server's reply, which is JSON most of the time and a
 * sentence or a stack trace the rest of it. So the decision is made by parsing
 * rather than by guessing from the caller, and a string that does not parse is
 * rendered exactly as it arrived.
 *
 * It renders no container. The three call sites keep their own — the chat's
 * wraps inside a narrow column, the preview's scrolls at a fixed height — and
 * only the colours are shared with `CodeBlock`.
 */

import { CodeTokens } from "./CodeBlock";

/**
 * Above this the tokenizer's regex passes are not worth the frame.
 *
 * It is a display cap, not a truncation: past it the text is shown plain and
 * whole. Tool results are already bounded before they reach the browser, so
 * this bites only on the largest of them.
 */
const MAX_HIGHLIGHT_CHARS = 20_000;

/**
 * The value re-printed at two-space indent, or null when the text is not JSON.
 *
 * Re-printing is the point as much as the colour: a provider sends arguments as
 * one long line, and the reason to open this row is to read them.
 */
function asPrettyJson(text: string): string | null {
  const trimmed = text.trim();
  // `JSON.parse` accepts bare scalars — `42`, `"ok"`, `null` — and colouring a
  // one-word answer as if it were a document is noise, not information.
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return null;
  }
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return null;
  }
}

export function JsonHighlight({ text }: { text: string }) {
  const pretty = text.length <= MAX_HIGHLIGHT_CHARS ? asPrettyJson(text) : null;
  return pretty === null ? <>{text}</> : <CodeTokens language="json" code={pretty} />;
}
