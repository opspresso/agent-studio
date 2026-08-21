import { describe, expect, it } from "vitest";
import { markdownPage } from "@/app/api/artifacts/[artifactId]/view/_lib/markdownPage";

function render(markdown: string, title = "report.md"): string {
  const page = markdownPage(new TextEncoder().encode(markdown), title);
  expect(page).not.toBeNull();
  return page!;
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
    expect(markdownPage(new TextEncoder().encode("hi"), undefined)).toContain(
      "<title>Artifact</title>",
    );
  });

  it("refuses bytes that are not text instead of rendering the wreckage", () => {
    // A PDF mislabelled `text/markdown`. `Buffer.toString("utf-8")` would answer
    // for it — a screen of replacement characters that renders as if it worked.
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff, 0xfe]);
    expect(markdownPage(pdf, "deck.md")).toBeNull();
  });
});
