/**
 * HTML to the text a model should read.
 *
 * It sits behind `DocumentExtractor` rather than beside the URL tool, so an
 * attached `.html` file and a fetched page become text through the same path.
 *
 * This is a readability heuristic, not a DOM parser. A real parser would be a
 * dependency with its own attack surface, and the job here is narrow: strip the
 * markup a model cannot use and keep the structure it can — paragraph breaks,
 * list items, table cells. Where the two disagree, readability wins over
 * fidelity.
 *
 * The output shape is deliberate and stable: blocks separated by one blank
 * line, `<br>` and list items by a single newline, table cells by ` | `.
 *
 * What it does not do: run scripts, resolve `<iframe>`s, or apply CSS. Content
 * that only exists after JavaScript runs is invisible here, and that is the
 * honest outcome — a server that rendered pages would be a browser. `<pre>`
 * loses its internal spacing for the same reason the rest of the document does
 * (see `collapseSource` below); code fidelity is not what this is for.
 */

import { cutCodePoints } from "@/shared/utf8Text";

/**
 * Elements whose *contents* are markup, code, or metadata — never body prose.
 *
 * `title` is here even though it is kept: `titleOf` reads it off the raw input
 * before this runs, and dropping it afterwards is what stops it appearing twice
 * in a document that has no `<head>` for the removal below to catch.
 */
/**
 * How far a tag's attributes may run before this stops reading it as a tag.
 *
 * The bound is on the *work*, not on the markup: `[^>]*` after an element name
 * scans to the end of the input at every position the name appears, so a page
 * of `<svg` with no `>` anywhere costs one full pass per occurrence — quadratic,
 * and measured at 24 seconds of blocked event loop for a document inside the
 * source cap below. That is the failure the cap was supposed to prevent, and a
 * cap on length cannot: the work is what has to be bounded. A kilobyte covers
 * every tag a page really writes (a `style`, a `srcset`, a `data-` payload) and
 * takes the pathological case from quadratic to linear-with-a-constant.
 *
 * A tag whose attributes run past it is left alone here and removed by
 * `stripTags`, which scans rather than backtracks and has no bound at all.
 */
const MAX_TAG_CHARS = 1024;

const DROPPED_ELEMENTS = ["script", "style", "noscript", "svg", "template", "iframe", "title"];

/** Blocks that read as paragraphs: one blank line between them. */
const PARAGRAPH_ELEMENTS =
  "p|div|section|article|header|footer|main|aside|blockquote|pre|h[1-6]|ul|ol|dl|table|form|figure|figcaption";

/**
 * Named entities worth handling without a table of all 2,231 of them. `&amp;`
 * is absent on purpose — it is decoded last, below, or `&amp;lt;` would come
 * out as `<` instead of `&lt;`.
 */
const NAMED_ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * Own keys only. `&constructor;` is letters like any other entity name, so the
 * pattern below matches it and a plain lookup answers with
 * `Object.prototype.constructor` — a function `??` reads as a hit and
 * stringifies into the extracted text, from any page that contains the word.
 * `domain/trigger/cron.ts` refuses the same shape for the same reason.
 */
function namedEntity(name: string): string | undefined {
  return Object.hasOwn(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : undefined;
}

/** Decode the entity forms that actually appear in prose. */
export function decodeEntities(value: string): string {
  return (
    value
      .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => codePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec: string) => codePoint(Number(dec)))
      .replace(/&([a-z]+);/gi, (match, name: string) => namedEntity(name.toLowerCase()) ?? match)
      // Last: an escaped ampersand may itself introduce an entity that was never
      // meant to be decoded.
      .replace(/&amp;/gi, "&")
  );
}

/** A numeric reference that is out of range or a surrogate is dropped rather
 * than becoming U+FFFD — a replacement character reads as corruption. */
function codePoint(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) {
    return "";
  }
  if (value >= 0xd800 && value <= 0xdfff) {
    return "";
  }
  return String.fromCodePoint(value);
}

/**
 * Whitespace in the *source* carries no meaning in HTML — a paragraph broken
 * across source lines is one paragraph. Flattening it before any structural
 * newline is inserted is what keeps those two kinds of newline apart; doing it
 * afterwards would make every hard-wrapped source line its own line of output.
 */
function collapseSource(value: string): string {
  return value.replace(/\s+/g, " ");
}

/** Also drops a trailing unterminated tag, which has no `>` to match. */
function stripTags(value: string): string {
  // A scan rather than `/<[^>]*>/g`: that pattern re-reads the rest of the
  // input from every `<` that has no `>` after it, which is the same quadratic
  // the tag bound above exists to stop — and this is the pass that has to take
  // a tag of any length, because a page inlines a `data:` image as one. Two
  // cursors and `indexOf` read each character once, and answer exactly what the
  // pattern answered: a tag removed, a trailing unterminated one dropped.
  let out = "";
  let at = 0;
  for (;;) {
    const open = value.indexOf("<", at);
    if (open < 0) {
      return out + value.slice(at);
    }
    out += value.slice(at, open);
    const close = value.indexOf(">", open + 1);
    if (close < 0) {
      return out;
    }
    at = close + 1;
  }
}

/**
 * The page title, which is the one piece of `<head>` worth keeping: it is often
 * the only statement of what the document *is*.
 */
function titleOf(html: string): string | undefined {
  const match = new RegExp(`<title[^>]{0,${MAX_TAG_CHARS}}>([\\s\\S]*?)<\\/title>`, "i").exec(html);
  const title = match?.[1] ? decodeEntities(stripTags(collapseSource(match[1]))).trim() : "";
  return title || undefined;
}

/**
 * How much markup is worth reading through.
 *
 * Our cap, beside the regex chain that spends it — and lower than the standalone
 * server's, deliberately. There this ran in its own pod, where a long synchronous
 * pass blocked only that pod and horizontal scaling absorbed it; here it shares
 * an event loop with every other request this instance is serving, health probes
 * included. Half a megabyte of markup is generous for the 90,000 characters of
 * text that can come out of it.
 */
export const MAX_HTML_SOURCE_CHARS = 500_000;

export function htmlToText(source: string): string {
  // Cut before the passes rather than after: the work below is linear in what it
  // is given, and the tail of a very long page contributes nothing once the text
  // budget is spent anyway. The element regexes below already tolerate input cut
  // mid-element — that is what their `|$` alternatives are for. Not through a
  // character, though: what comes out of here is what a model reads, and a cut
  // between the halves of a non-BMP character goes on the wire as a lone
  // surrogate escape that a provider may refuse the whole request over.
  const html = cutCodePoints(source, MAX_HTML_SOURCE_CHARS);
  const title = titleOf(html);

  let text = html
    // Comments first: one can contain anything, including a `<script>` that the
    // element pass below would otherwise try to match across.
    .replace(/<!--[\s\S]*?(?:-->|$)/g, " ");

  // `|$` rather than requiring the close tag. The source reaching this function
  // may have been cut mid-element — `MAX_HTML_CHARS` does exactly that — and an
  // opening tag whose closer was cut off would otherwise match nothing, leaving
  // `stripTags` to remove the tag and hand the model the script source it
  // wrapped, labelled as the document's prose. Consuming to the end of the input
  // is also what a parser does with an unterminated raw-text element.
  //
  // `(?<!/)` is what keeps that from eating a document whole: `<script src="a"/>`
  // is a self-closing tag, ordinary in the XHTML this server also accepts, and it
  // has no contents and no closer to look for. Without the lookbehind it opened
  // an element that ran to the end of the page.
  for (const element of DROPPED_ELEMENTS) {
    text = text.replace(
      new RegExp(`<${element}\\b[^>]{0,${MAX_TAG_CHARS}}(?<!/)>[\\s\\S]*?(?:<\\/${element}\\s*>|$)`, "gi"),
      " ",
    );
  }

  text = collapseSource(text.replace(new RegExp(`<head\\b[^>]{0,${MAX_TAG_CHARS}}>[\\s\\S]*?<\\/head\\s*>`, "gi"), " "));

  text = text
    // Single-newline boundaries: these group rather than separate.
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(tr|dt|dd)\s*>/gi, "\n")
    .replace(new RegExp(`<li\\b[^>]{0,${MAX_TAG_CHARS}}>`, "gi"), "\n- ")
    // Cell boundaries carry meaning in a table — a row of values run together
    // is not readable as a row.
    .replace(/<\/t[dh]\s*>/gi, " | ")
    // Paragraph boundaries, both ends: a block is separated from its neighbour
    // whether the markup closed the previous one or not.
    .replace(new RegExp(`<\\/(${PARAGRAPH_ELEMENTS})\\s*>`, "gi"), "\n\n")
    .replace(new RegExp(`<(${PARAGRAPH_ELEMENTS})\\b[^>]{0,${MAX_TAG_CHARS}}>`, "gi"), "\n\n");

  const body = normalize(decodeEntities(stripTags(text)));

  // The title is prepended rather than merged: it came from `<head>`, so it is
  // not part of the body's own flow and should not read as its first sentence.
  return title && !body.startsWith(title) ? `${title}\n\n${body}`.trim() : body;
}

/** Trim each line, drop leading/trailing blanks, and never allow two in a row. */
function normalize(text: string): string {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    // A trailing cell separator is an artifact of the last `</td>`, not content.
    const line = raw.replace(/[^\S\n]+/g, " ").trim().replace(/\s*\|$/, "").trim();
    if (line === "") {
      if (out.length > 0 && out[out.length - 1] !== "") {
        out.push("");
      }
      continue;
    }
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === "") {
    out.pop();
  }
  return out.join("\n");
}
