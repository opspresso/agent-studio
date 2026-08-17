/**
 * Fenced code blocks, as the Markdown renderers this platform sends to read
 * them: a fence opens at three backticks followed by an optional info string
 * and a line break, and closes at the next three backticks — anywhere, not
 * only at a line start, because that is how the Telegram renderer and Teams'
 * own reader both behave. One reading of "is a fence open here", so a piece
 * boundary and a tail appended after the answer agree with the renderer.
 */

const FENCE = /```([^\n`]*)\n([\s\S]*?)(```|$)/g;

/**
 * The info string of the fence `text` leaves open (`""` for a bare one), or
 * nothing when every fence in it is closed.
 */
export function openFenceAfter(text: string): string | undefined {
  let open: string | undefined;
  for (const match of text.matchAll(FENCE)) {
    open = match[3] === "```" ? undefined : (match[1] ?? "").trim();
  }
  return open;
}

/**
 * `text` with any fence it leaves open closed, so what is appended after it —
 * a file link, a warning — reads as prose rather than as the tail of the
 * block. A reply cut mid-block by a timeout is the ordinary case.
 */
export function closeOpenFence(text: string): string {
  return openFenceAfter(text) === undefined ? text : `${text}\n\`\`\``;
}
