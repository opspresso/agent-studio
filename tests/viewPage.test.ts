import { describe, expect, it } from "vitest";
import { viewPage } from "@/app/api/artifacts/[artifactId]/view/_lib/viewPage";
import { parseCsv } from "@/app/api/artifacts/[artifactId]/view/_lib/csv";

function page(view: "markdown" | "csv" | "json" | "svg" | "text", source: string): string {
  const rendered = viewPage(view, new TextEncoder().encode(source), "report");
  expect(rendered).not.toBeNull();
  return rendered!;
}

function render(markdown: string, title = "report.md"): string {
  const rendered = viewPage("markdown", new TextEncoder().encode(markdown), title);
  expect(rendered).not.toBeNull();
  return rendered!;
}

describe("a markdown artifact as a page", () => {
  it("renders GFM, so a report reads the way it does in the chat thread", () => {
    // The same renderer both surfaces use. A second markdown dialect here is a
    // second set of edge cases in exactly these three constructs.
    const html = render("# 제목\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n");

    expect(html).toContain("<h1>제목</h1>");
    expect(html).toContain("<table>");
    expect(html).toContain('type="checkbox"');
  });

  it("is a whole document, declaring the encoding Korean text needs", () => {
    const html = render("안녕");

    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain("<title>report.md</title>");
    // Self-contained: the page runs under `default-src 'none'`, so a stylesheet
    // it had to fetch would simply never arrive.
    expect(html).toContain("<style>");
    expect(html).not.toContain("<link rel=\"stylesheet\"");
  });

  it("escapes a filename rather than letting it close the title", () => {
    const html = render("hi", '</title><script>alert(1)</script>');
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;/title&gt;");
  });

  it("carries no script of its own, whatever the markdown asked for", () => {
    // This is what lets the view refuse `allow-scripts` for markdown: raw HTML
    // becomes text and a `javascript:` href is stripped, so there is nothing to
    // run even before the sandbox says so.
    const html = render("<script>alert(1)</script>\n\n[x](javascript:alert(1))\n");

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("javascript:");
  });

  it("falls back to a name rather than an empty title", () => {
    expect(render("hi", "   ")).toContain("<title>Artifact</title>");
    expect(viewPage("markdown", new TextEncoder().encode("hi"), undefined)).toContain(
      "<title>Artifact</title>",
    );
  });

  it("refuses bytes that are not text instead of rendering the wreckage", () => {
    // A PDF mislabelled `text/markdown`. `Buffer.toString("utf-8")` would answer
    // for it — a screen of replacement characters that renders as if it worked.
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff, 0xfe]);
    expect(viewPage("markdown", pdf, "deck.md")).toBeNull();
  });
});

describe("a CSV as the table it describes", () => {
  it("makes the first row the header, which is what the media type registers", () => {
    const html = page("csv", "provider,share\nAWS,29%\nAzure,20%\n");

    expect(html).toContain("<thead><tr><th>provider</th><th>share</th></tr></thead>");
    expect(html).toContain("<td>AWS</td><td>29%</td>");
  });

  it("keeps a quoted comma in one cell", () => {
    // The failure a naive split produces is silent: the row gains a column and
    // the table renders as if that were the data.
    const html = page("csv", 'a,b\n"Seoul, KR",1\n');
    expect(html).toContain("<td>Seoul, KR</td><td>1</td>");
  });

  it("escapes a cell rather than letting it become markup", () => {
    const html = page("csv", 'a\n"<img src=x onerror=alert(1)>"\n');
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  it("says what it left out instead of ending the table quietly", () => {
    const rows = ["h", ...Array.from({ length: 2500 }, (_, i) => String(i))].join("\n");
    const html = page("csv", rows);

    expect(html).toContain("Showing the first 2,000 of 2,500 rows");
    expect(html.match(/<tr>/g)).toHaveLength(2001);
  });
});

describe("parsing delimiter-separated rows", () => {
  it("reads the three rules RFC 4180 has", () => {
    expect(parseCsv('a,b\n"x,y","he said ""hi"""\n')).toEqual([
      ["a", "b"],
      ["x,y", 'he said "hi"'],
    ]);
  });

  it("keeps a newline that is inside a quoted field", () => {
    expect(parseCsv('a\n"one\ntwo"\n')).toEqual([["a"], ["one\ntwo"]]);
  });

  it("reads CRLF as one break and a bare quote mid-field as a character", () => {
    expect(parseCsv("a,b\r\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(parseCsv('a"b\n')).toEqual([['a"b']]);
  });

  it("does not invent a row after a trailing newline", () => {
    expect(parseCsv("a\nb\n")).toEqual([["a"], ["b"]]);
    expect(parseCsv("a\nb")).toEqual([["a"], ["b"]]);
  });
});

describe("the other kinds", () => {
  it("re-indents JSON", () => {
    const html = page("json", '{"a":[1,2],"b":{"c":true}}');
    expect(html).toContain('&quot;a&quot;: [\n    1,');
    expect(html).toContain('class="raw"');
  });

  it("shows a .json that is not JSON as the text it is, and says so", () => {
    // A run writes this by hand into a string argument, so this is a real
    // outcome rather than corruption — and it is still what the reader was
    // handed.
    const html = page("json", "{oops");
    expect(html).toContain("not valid JSON");
    expect(html).toContain("{oops");
  });

  it("draws an SVG through <img>, which by specification runs nothing", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const html = page("svg", svg);

    expect(html).toContain('<img src="data:image/svg+xml;base64,');
    // Never inlined — the markup does not reach the document at all.
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("shows plain text as plain text, escaped", () => {
    const html = page("text", "a < b & c\n\tindented");
    expect(html).toContain("a &lt; b &amp; c");
    expect(html).toContain('class="raw"');
  });
});
