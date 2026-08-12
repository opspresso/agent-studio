/**
 * The HTML stripper is hand-written, which is the right trade for a dependency
 * with its own attack surface — but it is also the kind of code that degrades
 * without anyone noticing, because its output is prose nobody diffs. These pin
 * the behaviours that would silently get worse.
 *
 * Brought over with the converter itself from the `mcp-url-fetch` server, so the
 * page a run reads through `FetchUrl` is the same text that server returned.
 */

import { describe, expect, it } from "vitest";
import { decodeEntities, htmlToText, MAX_HTML_SOURCE_CHARS } from "@/infrastructure/llm/htmlText";

const expectEqual = (actual: unknown, expected: unknown) => expect(actual).toEqual(expected);
const expectMatch = (actual: string, pattern: RegExp) => expect(actual).toMatch(pattern);
const expectOk = (actual: unknown) => expect(actual).toBeTruthy();

describe("htmlToText", () => {


it("drops script and style contents, not just their tags", () => {
  const text = htmlToText(
    `<p>before</p><script>var evil = "steal";</script><style>.a{color:red}</style><p>after</p>`,
  );
  expectEqual(text, "before\n\nafter");
});

it("keeps the title, once", () => {
  expectEqual(htmlToText("<title>Report</title><body><p>body</p></body>"), "Report\n\nbody");
  // A page whose body already opens with the title should not say it twice.
  expectEqual(
    htmlToText("<title>Report</title><body><h1>Report</h1><p>x</p></body>"),
    "Report\n\nx",
  );
});

it("separates blocks by a blank line and <br> by one newline", () => {
  expectEqual(htmlToText("<p>one</p><p>two</p>"), "one\n\ntwo");
  expectEqual(htmlToText("a<br>b<br/>c"), "a\nb\nc");
  expectEqual(htmlToText("<h1>Title</h1><div>body</div>"), "Title\n\nbody");
});

it("source newlines inside a block are not output newlines", () => {
  // HTML says whitespace in the source is insignificant. A hard-wrapped
  // paragraph is one paragraph.
  expectEqual(htmlToText("<p>one\ntwo\nthree</p>"), "one two three");
});

it("marks list items so a list reads as one", () => {
  expectEqual(htmlToText("<ul><li>a</li><li>b</li></ul>"), "- a\n- b");
});

it("keeps table cells apart", () => {
  const text = htmlToText("<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>");
  expectEqual(text, "a | b\nc | d");
});

it("collapses whitespace without merging paragraphs", () => {
  expectEqual(htmlToText("<p>a   \n  b</p><p>c</p>"), "a b\n\nc");
});

it("never emits two blank lines in a row", () => {
  expectEqual(htmlToText("<div><p>a</p></div><div><p>b</p></div>"), "a\n\nb");
});

it("a comment cannot swallow the markup after it", () => {
  expectEqual(htmlToText("<p>a</p><!-- <script>x</script> --><p>b</p>"), "a\n\nb");
});

it("an unterminated dropped element does not leak its contents as prose", () => {
  // The source is cut at MAX_HTML_CHARS before it gets here, so this function
  // does receive markup that stops mid-element. A `<script>` whose `</script>`
  // was cut off used to have only its opening tag removed, and its JavaScript
  // came back as the page's text.
  expectEqual(htmlToText(`<p>prose</p><script>var secret = "token"; // cut here`), "prose");
  expectEqual(htmlToText(`<p>prose</p><style>.a{color:red}`), "prose");
  expectEqual(htmlToText(`<p>prose</p><!-- a comment that never closes`), "prose");
});

it("a self-closing dropped element is not an unterminated one", () => {
  // `application/xhtml+xml` is a type this reads, and there `<script src="a"/>`
  // is how a script is written. It has no contents and no closing tag to look
  // for, so treating it as unterminated took the rest of the document with it.
  expectEqual(htmlToText(`<p>before</p><script src="a.js"/><p>after</p>`), "before\n\nafter");
  expectEqual(htmlToText(`<p>before</p><svg/><p>after</p>`), "before\n\nafter");
  // And an attribute that merely ends in a slash still opens a real element.
  expectEqual(htmlToText(`<p>before</p><script data-p="a/">x</script><p>after</p>`), "before\n\nafter");
});

it("ignores an unterminated tag rather than eating the document", () => {
  expectEqual(htmlToText("<p>visible</p><div class="), "visible");
});

it("decodes the entity forms that appear in prose", () => {
  expectEqual(decodeEntities("a &lt; b &gt; c"), "a < b > c");
  expectEqual(decodeEntities("&quot;q&quot; &apos;a&apos;"), `"q" 'a'`);
  expectEqual(decodeEntities("&#65;&#66;&#x43;"), "ABC");
  expectEqual(decodeEntities("&#xD55C;"), "한");
});

it("decodes an escaped ampersand last", () => {
  // `&amp;lt;` is a literal `&lt;`, not a `<`. Decoding `&amp;` first loses that.
  expectEqual(decodeEntities("&amp;lt;"), "&lt;");
  expectEqual(decodeEntities("a &amp; b"), "a & b");
});

it("leaves an unknown entity alone", () => {
  expectEqual(decodeEntities("&notanentity; &copy;"), "&notanentity; &copy;");
});

it("drops an out-of-range numeric reference instead of emitting U+FFFD", () => {
  expectEqual(decodeEntities("a&#xD800;b"), "ab");
  expectEqual(decodeEntities("a&#1114112;b"), "ab");
});

it("returns empty for markup with no prose", () => {
  expectEqual(htmlToText("<html><head><style>.a{}</style></head><body></body></html>"), "");
});
});
