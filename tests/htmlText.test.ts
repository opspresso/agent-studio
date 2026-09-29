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
import { decodeEntities, htmlToText } from "@/infrastructure/llm/htmlText";

const textOf = (source: string) => htmlToText(source).text;

const expectEqual = (actual: unknown, expected: unknown) => expect(actual).toEqual(expected);

describe("htmlToText", () => {


it("drops script and style contents, not just their tags", () => {
  const text = textOf(
    `<p>before</p><script>var evil = "steal";</script><style>.a{color:red}</style><p>after</p>`,
  );
  expectEqual(text, "before\n\nafter");
});

it("keeps the title, once", () => {
  expectEqual(textOf("<title>Report</title><body><p>body</p></body>"), "Report\n\nbody");
  // A page whose body already opens with the title should not say it twice.
  expectEqual(
    textOf("<title>Report</title><body><h1>Report</h1><p>x</p></body>"),
    "Report\n\nx",
  );
});

it("recognizes complete tag names and ignores titles inside comments", () => {
  expectEqual(textOf("<!-- <title>hidden</title> --><p>body</p>"), "body");
  expectEqual(textOf("<title-extra>visible</title-extra><p>body</p>"), "visible\n\nbody");
});

it("drops raw element contents even when attributes are long or contain angle brackets", () => {
  const attribute = "x".repeat(3000);
  expectEqual(textOf(`<p>before</p><script data-value="${attribute}">private code</script><p>after</p>`), "before\n\nafter");
  expectEqual(textOf('<p>before</p><script data-value="a>b">private code</script><p>after</p>'), "before\n\nafter");
  expectEqual(textOf('<p title="a>b">visible</p>'), "visible");
  expectEqual(textOf('<script>const code = "<unfinished";</script><p>after</p>'), "after");
  expectEqual(textOf('<script>const code = "<title>hidden</title>";</script><p>after</p>'), "after");
});

it("separates blocks by a blank line and <br> by one newline", () => {
  expectEqual(textOf("<p>one</p><p>two</p>"), "one\n\ntwo");
  expectEqual(textOf("a<br>b<br/>c"), "a\nb\nc");
  expectEqual(textOf("<h1>Title</h1><div>body</div>"), "Title\n\nbody");
});

it("source newlines inside a block are not output newlines", () => {
  // HTML says whitespace in the source is insignificant. A hard-wrapped
  // paragraph is one paragraph.
  expectEqual(textOf("<p>one\ntwo\nthree</p>"), "one two three");
});

it("marks list items so a list reads as one", () => {
  expectEqual(textOf("<ul><li>a</li><li>b</li></ul>"), "- a\n- b");
});

it("keeps table cells apart", () => {
  const text = textOf("<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>");
  expectEqual(text, "a | b\nc | d");
});

it("collapses whitespace without merging paragraphs", () => {
  expectEqual(textOf("<p>a   \n  b</p><p>c</p>"), "a b\n\nc");
});

it("never emits two blank lines in a row", () => {
  expectEqual(textOf("<div><p>a</p></div><div><p>b</p></div>"), "a\n\nb");
});

it("a comment cannot swallow the markup after it", () => {
  expectEqual(textOf("<p>a</p><!-- <script>x</script> --><p>b</p>"), "a\n\nb");
});

it("an unterminated dropped element does not leak its contents as prose", () => {
  // The source is cut at MAX_HTML_CHARS before it gets here, so this function
  // does receive markup that stops mid-element. A `<script>` whose `</script>`
  // was cut off would have only its opening tag removed, and its JavaScript
  // came back as the page's text.
  expectEqual(textOf(`<p>prose</p><script>var secret = "token"; // cut here`), "prose");
  expectEqual(textOf(`<p>prose</p><style>.a{color:red}`), "prose");
  expectEqual(textOf(`<p>prose</p><!-- a comment that never closes`), "prose");
});

it("a self-closing dropped element is not an unterminated one", () => {
  // `application/xhtml+xml` is a type this reads, and there `<script src="a"/>`
  // is how a script is written. It has no contents and no closing tag to look
  // for, so treating it as unterminated took the rest of the document with it.
  expectEqual(textOf(`<p>before</p><script src="a.js"/><p>after</p>`), "before\n\nafter");
  expectEqual(textOf(`<p>before</p><svg/><p>after</p>`), "before\n\nafter");
  // And an attribute that merely ends in a slash still opens a real element.
  expectEqual(textOf(`<p>before</p><script data-p="a/">x</script><p>after</p>`), "before\n\nafter");
});

it("ignores an unterminated tag rather than eating the document", () => {
  expectEqual(textOf("<p>visible</p><div class="), "visible");
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

it("treats an entity named after an Object.prototype member as unknown", () => {
  // The pattern is `[a-z]+`, so these are entity names like any other. A plain
  // lookup on the table answers them with a function off the prototype, which
  // reads as a hit — and a fetched page saying "&constructor;" would put
  // "function Object() { [native code] }" into what the model is handed.
  expectEqual(
    decodeEntities("&constructor; &toString; &valueOf;"),
    "&constructor; &toString; &valueOf;",
  );
});

it("drops an out-of-range numeric reference instead of emitting U+FFFD", () => {
  expectEqual(decodeEntities("a&#xD800;b"), "ab");
  expectEqual(decodeEntities("a&#1114112;b"), "ab");
});

it("returns empty for markup with no prose", () => {
  expectEqual(textOf("<html><head><style>.a{}</style></head><body></body></html>"), "");
});

it("caps a very long page without splitting a character", () => {
  // The source cap lands wherever 500,000 characters land, which for a page of
  // emoji or CJK ext-B is the middle of one. What comes out of here is what a
  // model reads, and a lone surrogate goes on the wire as a `\ud800`-range
  // escape a provider can refuse the whole request over.
  const text = textOf(`<p>${"\uD83D\uDE00".repeat(400_000)}</p>`);
  expect(text.isWellFormed()).toBe(true);
});

it("reports the source window independently of the extracted text length", () => {
  const source = "<p>FIRST</p><!--" + "x".repeat(500_001) + "--><p>LAST</p>";
  expect(htmlToText(source)).toEqual({ text: "FIRST", complete: false, sourceChars: source.length, readChars: 500_000 });
  expect(htmlToText("<p>all</p>")).toEqual({ text: "all", complete: true, sourceChars: 10, readChars: 10 });
});
});

/** Tag and element scans must also handle malformed input within the source cap. */
describe("markup that is nothing but openings", () => {
  it("handles repeated complete title/head openings without a closing element", () => {
    expectEqual(textOf("<title>".repeat(20_000)), "");
    expectEqual(textOf("<head>".repeat(20_000) + "<p>visible</p>"), "visible");
  });
  it("drops pathological unterminated openings without leaking markup", () => {
    // An unfinished tag consumes the remaining markup without exposing it as prose.
    expectEqual(textOf("<script".repeat(2_000)), "");
    expectEqual(textOf("<svg".repeat(2_000)), "");
    expectEqual(textOf("<p".repeat(2_000)), "");
    // Every opening closed by one `>` at the very end: each attribute run still
    // has a `>` to find, at the far end of the document.
    expectEqual(textOf(`${"<script".repeat(2_000)}>`), "");
  });

  it("removes long quoted data URL tags", () => {
    const page = `<p>before</p><img src="data:image/png;base64,${"A".repeat(200_000)}"><p>after</p>`;
    expectEqual(textOf(page), "before\n\nafter");
  });
});
