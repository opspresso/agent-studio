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

/** Elements whose contents are code or metadata rather than body prose. */
const DROPPED_ELEMENTS = ["script", "style", "noscript", "svg", "template", "iframe"];

/** Blocks that read as paragraphs: one blank line between them. */
const PARAGRAPH_ELEMENTS = new Set([
  "p", "div", "section", "article", "header", "footer", "main", "aside", "blockquote", "pre",
  "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "dl", "table", "form", "figure", "figcaption",
]);

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

interface HtmlTag {
  start: number;
  end: number;
  name: string;
  closing: boolean;
  selfClosing: boolean;
  terminated: boolean;
}

/** One forward pass, including quoted attributes and a trailing unfinished tag. */
function* tags(value: string, at = 0): Generator<HtmlTag> {
  while (at < value.length) {
    const open = value.indexOf("<", at);
    if (open < 0) return;
    let close = open + 1;
    let quote = "";
    for (; close < value.length; close += 1) {
      const character = value[close];
      if (quote) {
        if (character === quote) quote = "";
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === ">") {
        break;
      }
    }
    const content = value.slice(open + 1, close);
    const name = /^\/?([a-z][a-z0-9:_-]*)(?=[\s/]|$)/i.exec(content)?.[1]?.toLowerCase() ?? "";
    at = Math.min(close + 1, value.length);
    yield { start: open, end: at, name, closing: content.startsWith("/"),
      selfClosing: content.trimEnd().endsWith("/"), terminated: close < value.length };
  }
}

/** Match element contents without retrying every nested opener on a missing closer. */
function* elements(value: string, name: string) {
  const closing = new RegExp(`<\\/${name}\\s*>`, "gi");
  let at = 0;
  while (at < value.length) {
    let opening: HtmlTag | undefined;
    for (const tag of tags(value, at)) {
      if (tag.name === name && tag.terminated && !tag.closing && !tag.selfClosing) {
        opening = tag;
        break;
      }
    }
    if (!opening) return;
    // Raw contents may contain strings that resemble unfinished HTML tags.
    closing.lastIndex = opening.end;
    const close = closing.exec(value);
    const end = close ? closing.lastIndex : value.length;
    yield { start: opening.start, contentStart: opening.end, contentEnd: close?.index ?? value.length,
      end, closed: close !== null };
    at = end;
  }
}

function dropElement(value: string, name: string, dropUnclosed = true): string {
  let out = "";
  let at = 0;
  for (const element of elements(value, name)) {
    if (!element.closed && !dropUnclosed) break;
    out += `${value.slice(at, element.start)} `;
    at = element.end;
  }
  return out + value.slice(at);
}

function stripTags(value: string, boundaries = false): string {
  let out = "";
  let at = 0;
  for (const tag of tags(value)) {
    out += value.slice(at, tag.start);
    at = tag.end;
    if (!boundaries || !tag.terminated) continue;
    if (PARAGRAPH_ELEMENTS.has(tag.name)) out += "\n\n";
    else if (tag.name === "br" || tag.closing && ["tr", "dt", "dd"].includes(tag.name)) out += "\n";
    else if (tag.name === "li" && !tag.closing) out += "\n- ";
    else if (tag.closing && ["td", "th"].includes(tag.name)) out += " | ";
  }
  return out + value.slice(at);
}

/**
 * The page title, which is the one piece of `<head>` worth keeping: it is often
 * the only statement of what the document *is*.
 */
function titleOf(html: string): string | undefined {
  for (const element of elements(html, "title")) {
    if (!element.closed) return undefined;
    return decodeEntities(stripTags(collapseSource(html.slice(element.contentStart, element.contentEnd)))).trim() || undefined;
  }
  return undefined;
}

/**
 * How much markup is worth reading through.
 *
 * A linear scan budget inside the document worker. Half a megabyte of markup is
 * generous for the extracted text returned to the caller.
 */
export const MAX_HTML_SOURCE_CHARS = 500_000;

export function htmlToText(source: string): string {
  // Cut before the passes rather than after: the work below is linear in what it
  // is given, and the tail of a very long page contributes nothing once the text
  // budget is spent anyway. Element scans tolerate input cut mid-element. Not through a
  // character, though: what comes out of here is what a model reads, and a cut
  // between the halves of a non-BMP character goes on the wire as a lone
  // surrogate escape that a provider may refuse the whole request over.
  const html = cutCodePoints(source, MAX_HTML_SOURCE_CHARS);

  let text = html
    // Comments first: one can contain anything, including a `<script>` that the
    // element pass below would otherwise try to match across.
    .replace(/<!--[\s\S]*?(?:-->|$)/g, " ");

  // Truncated raw elements consume their remaining contents; self-closing
  // XHTML elements do not. Titles inside these elements are not page titles.
  for (const element of DROPPED_ELEMENTS) {
    text = dropElement(text, element);
  }
  const title = titleOf(text);
  text = dropElement(text, "title");
  text = collapseSource(dropElement(text, "head", false));
  const body = normalize(decodeEntities(stripTags(text, true)));

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
