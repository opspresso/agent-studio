import { describe, expect, it } from "vitest";
import {
  escapeTelegramHtml,
  markdownToTelegramHtml,
  markdownToTelegramHtmlPieces,
} from "@/application/telegram/markdown";

describe("markdownToTelegramHtml", () => {
  it("escapes what Telegram would read as markup", () => {
    expect(escapeTelegramHtml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
    expect(markdownToTelegramHtml("<script>")).toBe("&lt;script&gt;");
  });

  it("renders bold, italic, strikethrough, code and links", () => {
    expect(markdownToTelegramHtml("**bold** and *it* and _it_ and ~~gone~~ and `x<y`")).toBe(
      "<b>bold</b> and <i>it</i> and <i>it</i> and <s>gone</s> and <code>x&lt;y</code>",
    );
    expect(markdownToTelegramHtml("see [docs](https://example.com/a?b=1&c=2)")).toBe(
      'see <a href="https://example.com/a?b=1&amp;c=2">docs</a>',
    );
  });

  it("leaves markers inside words and code spans alone", () => {
    expect(markdownToTelegramHtml("snake_case_name and 2*3*4")).toBe("snake_case_name and 2*3*4");
    expect(markdownToTelegramHtml("`**not bold**`")).toBe("<code>**not bold**</code>");
  });

  it("renders fenced code as pre, with the language when named, and closes an unfinished fence", () => {
    expect(markdownToTelegramHtml("before\n```ts\nconst a = 1 < 2;\n```\nafter")).toBe(
      'before\n<pre><code class="language-ts">const a = 1 &lt; 2;</code></pre>\nafter',
    );
    expect(markdownToTelegramHtml("```\nstill open")).toBe("<pre>still open</pre>");
  });

  it("turns headings into bold and bullets into bullets", () => {
    expect(markdownToTelegramHtml("# Title\n- one\n* two\n  - nested")).toBe(
      "<b>Title</b>\n• one\n• two\n  • nested",
    );
  });

  it("does not link to anything but http(s)", () => {
    expect(markdownToTelegramHtml("[x](javascript:alert(1))")).toBe("[x](javascript:alert(1))");
  });
});

describe("markdownToTelegramHtmlPieces", () => {
  it("closes a fence on one side of a cut and reopens it on the other, wherever the fence opened", () => {
    // Opened mid-line — the renderer reads it as a fence, and so must the bookkeeping.
    const pieces = markdownToTelegramHtmlPieces(["a ```js\ncode", "more\n```\nafter [f](https://x)"]);
    expect(pieces[0]).toBe('a <pre><code class="language-js">code</code></pre>');
    expect(pieces[1]).toBe('<pre><code class="language-js">more</code></pre>\nafter <a href="https://x">f</a>');
  });

  it("appends nothing to a piece whose fences are all closed", () => {
    expect(markdownToTelegramHtmlPieces(["a ```js\ncode\n```\nafter"])).toEqual([
      'a <pre><code class="language-js">code</code></pre>\nafter',
    ]);
  });
});
