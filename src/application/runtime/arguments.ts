import { cutUtf8Bytes } from "@/shared/utf8Text";

const MAX_TOOL_ARG_BYTES = 16 * 1024;

/** What stands in for a value too large to keep. Its size, which is the fact. */
function elidedArg(bytes: number): string {
  return `[${bytes} bytes, elided — the call was made with the whole value]`;
}

/**
 * The arguments a call is *kept* with, which are not always the ones it is made
 * with.
 *
 * A call's arguments outlive the call twice over, and neither copy is bounded
 * by anything else. **The turn's assistant message carries them back to the
 * provider on every remaining turn of the run** — `contextBudget` charges them
 * and nothing can cut them, so one megabyte of `content` is about 350k tokens
 * re-sent per turn, past the window of most models in the catalog: a 400 from
 * the provider, mid-run, after the file was already delivered. And **the
 * announced copy is persisted onto one chat-message row** under a byte budget,
 * the cut caught and logged, taking the reply the reader just watched stream.
 *
 * So the value is swapped for its size, in both copies. The model is not
 * deprived of anything it needs: the tool result on the very same turn says the
 * file exists and what it is called, which is the whole of what a later turn
 * can act on. It cannot re-read what it wrote — it could not anyway, one run
 * later.
 *
 * **Keyed to size, not to a tool name.** The hazard is a large argument, and
 * `SaveFile` is only the first tool to have one: a document renderer takes the
 * document's text, and a model that emits a long string as an array of lines
 * arrives here with a large value under a name nothing anticipated.
 */
// A string is measured as itself, so the number a reader is shown is the
// one the tool result and the artifact row also report. Anything else — the
// shape a model reaches for when it cannot fit a string — is measured as it
// will be serialised, which is the cost it actually imposes.
function argByteSize(value: unknown): number {
  return typeof value === "string"
    ? Buffer.byteLength(value, "utf8")
    : Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
}

/**
 * One elision decision for both copies of a call's arguments.
 *
 * The PII mask tokens differ in length from the values they stand for, so a
 * value near the bound can cross it in one copy and not the other — and then
 * the arguments the provider replays and the arguments the reader was shown
 * stop telling the same story. Elision is decided per key on the larger of
 * the two measurements; each copy still reports its own true size.
 */
export function boundToolArgsPair(
  args: Record<string, unknown>,
  displayArgs: Record<string, unknown>,
): { wire: Record<string, unknown>; display: Record<string, unknown> } {
  let wire: Record<string, unknown> | undefined;
  let display: Record<string, unknown> | undefined;
  for (const key of Object.keys(args)) {
    const wireSize = argByteSize(args[key]);
    const displaySize = argByteSize(displayArgs[key]);
    if (Math.max(wireSize, displaySize) <= MAX_TOOL_ARG_BYTES) {
      continue;
    }
    wire ??= { ...args };
    display ??= { ...displayArgs };
    wire[key] = elidedArg(wireSize);
    display[key] = elidedArg(displaySize);
  }
  return { wire: wire ?? args, display: display ?? displayArgs };
}

/**
 * The same bound on a call whose arguments never parsed.
 *
 * There is no object here to take a value out of — the model's own text is the
 * only truthful record of what it asked for — so this cuts rather than elides,
 * and says where. A truncated `SaveFile` is the *likeliest* way an oversized
 * argument arrives: the provider cuts the turn at its output limit part-way
 * through the file, and the accumulator appends fragments with no cap of its
 * own.
 */
export function boundArgumentText(text: string): string {
  return Buffer.byteLength(text, "utf8") <= MAX_TOOL_ARG_BYTES
    ? text
    : `${cutUtf8Bytes(text, MAX_TOOL_ARG_BYTES)}…[truncated]`;
}

