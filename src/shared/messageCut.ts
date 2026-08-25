/**
 * Where a reply is cut when it outgrows one message — the single owner of that
 * decision.
 *
 * Every chat platform caps a message, and an answer longer than the cap becomes
 * several. *Where* it is cut is the part a reader sees: a cut at the character
 * the cap happens to land on stops a sentence — or a word — halfway and the next
 * message resumes mid-air, which reads as a bug even though every character
 * arrived. So the cut is pulled back to the last boundary within a window before
 * the cap, preferring the largest structure that fits.
 *
 * It lives here rather than beside one surface because three of them cut the
 * same way and only the caps differ.
 */

import { closeOpenFence, openFenceAfter } from "./markdownFence";

/** What {@link closeOpenFence} appends, which the cut before it has to leave room for. */
const CLOSING_FENCE = "\n```".length;

/** A sentence end that a following space confirms: `.`/`!`/`?` and their pairs. */
const SENTENCE_END = /[.!?][)\]"'”’]*\s/g;

/**
 * Where to end a message that has to be cut at `limit` characters from `from`.
 *
 * In preference order: a paragraph break, a line break, a sentence end, a space,
 * and finally the cap itself — never between the two halves of a surrogate pair,
 * because a lone surrogate is not UTF-8 and a platform refuses the whole write
 * for one. Each boundary is looked for in the last `window` characters before
 * the cap, so a paragraph is not split mid-sentence unless the paragraph itself
 * is longer than a message.
 *
 * The returned index is where the *next* message starts; the separator stays
 * with the message being closed, so nothing is dropped at a boundary. It is
 * always **greater than `from`** when a cut is needed at all — callers loop on
 * it, so standing still is an unbounded loop rather than a short message.
 */
export function cutPoint(text: string, from: number, limit: number, window: number): number {
  const hard = from + limit;
  if (text.length <= hard) {
    return text.length;
  }
  const start = Math.max(from, hard - window);
  const tail = text.slice(start, hard);
  const paragraph = tail.lastIndexOf("\n\n");
  if (paragraph > 0) {
    return start + paragraph + 2;
  }
  const newline = tail.lastIndexOf("\n");
  if (newline > 0) {
    return start + newline + 1;
  }
  let sentence = 0;
  for (const match of tail.matchAll(SENTENCE_END)) {
    sentence = (match.index ?? 0) + (match[0]?.length ?? 0);
  }
  if (sentence > 0) {
    return start + sentence;
  }
  const space = tail.lastIndexOf(" ");
  if (space > 0) {
    return start + space + 1;
  }
  const code = text.charCodeAt(hard - 1);
  const backed = code >= 0xd800 && code <= 0xdbff ? hard - 1 : hard;
  if (backed > from) {
    return backed;
  }
  // Never `from` itself. `layout` in `editInPlaceReply` feeds each answer back
  // as the next `from` and loops until the remainder fits, so a cut that does
  // not advance is not one short message — it is an unbounded loop on the
  // request thread of a reply the platform is waiting for. (`splitMessages`
  // notices the same thing and stops, which is why only one caller was ever
  // exposed.)
  //
  // Both ways in are a cap too small to hold one character: a `limit` of 1 in
  // front of a surrogate pair, which the back-off above would erase entirely,
  // and a `limit` of zero or less. The whole character — one unit over the cap
  // — is the only answer that is still text, and an oversized piece is the
  // platform's to refuse, which is already how the caller treats one.
  const first = text.charCodeAt(from);
  return first >= 0xd800 && first <= 0xdbff && from + 1 < text.length ? from + 2 : from + 1;
}

/** One message's worth of an answer. */
export interface MessagePiece {
  /** What to send, `prefix` included. */
  text: string;
  /** How much of the source this piece consumed, as an index into it. */
  end: number;
  /**
   * The fence this piece had to reopen because the piece before it was cut
   * inside a code block. Empty for a piece that continues prose.
   */
  prefix: string;
}

/**
 * An answer laid out as messages of at most `room` characters, with code blocks
 * balanced across every cut: the message being closed gets the fence the cut
 * left open, and the next one reopens it with the same info string, so each
 * message renders as a block on its own rather than one of them showing the
 * markup and the other the raw source.
 *
 * The alternative — pushing a whole block to the next message so it is never cut
 * — is not available to a reply that is still arriving: the block's end has not
 * been written yet.
 *
 * `prefix` is what the first piece must reopen, for a caller resuming a cut it
 * made on an earlier pass. `end` is an index into `text` and excludes it.
 */
export function splitMessages(
  text: string,
  opts: { room: number; window: number; prefix?: string },
): MessagePiece[] {
  const pieces: MessagePiece[] = [];
  let at = 0;
  let prefix = opts.prefix ?? "";
  for (;;) {
    const rest = prefix + text.slice(at);
    // A piece that is not the last may have to carry a closing fence, and that
    // fence counts against the platform's cap like any other character.
    const cut =
      rest.length <= opts.room
        ? rest.length
        : cutPoint(rest, 0, opts.room - CLOSING_FENCE, opts.window);
    const consumed = cut - prefix.length;
    // The whole remainder fits, or the cut landed inside the reopened fence and
    // there is no progress to be made by splitting again. Either way this is the
    // last piece; an oversized one is the platform's to refuse, and the caller
    // shrinks its room and comes back.
    if (cut >= rest.length || consumed <= 0) {
      pieces.push({ text: rest, end: text.length, prefix });
      return pieces;
    }
    const head = rest.slice(0, cut);
    pieces.push({ text: closeOpenFence(head), end: at + consumed, prefix });
    const open = openFenceAfter(head);
    prefix = open === undefined ? "" : `\`\`\`${open}\n`;
    at += consumed;
  }
}
