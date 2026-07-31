import { describe, expect, it } from "vitest";
import { firstHeadingOrLine, parseFrontmatter } from "@/shared/frontmatter";

describe("parseFrontmatter", () => {
  it("returns every field, not only the one a caller happens to want", () => {
    const doc = "---\nname: fetcher\ndescription: Fetches pages\nurl: https://x.test/mcp\n---\nBody";
    expect(parseFrontmatter(doc)).toEqual({
      fields: { name: "fetcher", description: "Fetches pages", url: "https://x.test/mcp" },
      body: "Body",
    });
  });

  it("treats a document without frontmatter as all body", () => {
    expect(parseFrontmatter("# Title\ntext")).toEqual({ fields: {}, body: "# Title\ntext" });
  });

  it("folds a multi-line scalar into one line", () => {
    const doc = "---\ndescription: >\n  first part\n  second part\n---\nBody";
    expect(parseFrontmatter(doc).fields.description).toBe("first part second part");
  });

  it("strips surrounding quotes and lowercases keys", () => {
    const doc = '---\nURL: "https://x.test/mcp"\n---\nBody';
    expect(parseFrontmatter(doc).fields.url).toBe("https://x.test/mcp");
  });

  it("ignores a line that is not a flat key/value", () => {
    const doc = "---\nnested:\n  - a\ndescription: kept\n---\nBody";
    expect(parseFrontmatter(doc).fields.description).toBe("kept");
  });

  it("does not mistake a horizontal rule mid-document for a block", () => {
    const doc = "Intro\n\n---\n\nMore";
    expect(parseFrontmatter(doc)).toEqual({ fields: {}, body: doc });
  });
});

describe("firstHeadingOrLine", () => {
  it("strips heading marks and skips leading blank lines", () => {
    expect(firstHeadingOrLine("\n\n## Fetch pages\nrest")).toBe("Fetch pages");
  });

  it("caps the length so it stays usable as a one-line summary", () => {
    expect(firstHeadingOrLine("x".repeat(500))).toHaveLength(200);
  });
});
