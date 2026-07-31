import { describe, expect, it } from "vitest";
import { DocumentExtractionError } from "@/domain/llm/documentExtractor";
import { documentExtractor } from "@/infrastructure/llm/documentExtractor";
import { documentKind } from "@/domain/llm/documentLimits";

/** A minimal one-page PDF with a real text layer, so no fixture file is needed. */
const PDF_WITH_TEXT = Buffer.from(
  `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 44>>stream
BT /F1 12 Tf 20 100 Td (Quarterly revenue rose) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>`,
  "latin1",
);

describe("documentKind", () => {
  it("reads a PDF by its declared type", () => {
    expect(documentKind("application/pdf", "report.pdf")).toBe("pdf");
  });

  it("reads a PDF that was labelled as bytes, by its name", () => {
    // The common case this exists for: uploads and Slack both hand over
    // `application/octet-stream` for files that are perfectly ordinary.
    expect(documentKind("application/octet-stream", "report.pdf")).toBe("pdf");
  });

  it("reads a markdown file the browser could not label", () => {
    expect(documentKind("", "notes.md")).toBe("text");
  });

  it("takes any text type, and the structured application ones", () => {
    expect(documentKind("text/csv", "rows.csv")).toBe("text");
    expect(documentKind("application/json", "a.json")).toBe("text");
    expect(documentKind("application/vnd.api+json", "a")).toBe("text");
  });

  it("is not a document for an image, whatever it is called", () => {
    // Images have their own path; one arriving here would be read as bytes
    // rather than looked at.
    expect(documentKind("image/png", "chart.png")).toBeNull();
    expect(documentKind("image/png", "chart.pdf.png")).toBeNull();
  });

  it("refuses what it cannot read", () => {
    expect(documentKind("application/zip", "bundle.zip")).toBeNull();
    expect(documentKind("application/octet-stream", "unknown")).toBeNull();
  });
});

describe("extracting a document", () => {
  it("reads a PDF's text layer", async () => {
    const result = await documentExtractor.extract({
      bytes: PDF_WITH_TEXT,
      mimeType: "application/pdf",
      name: "report.pdf",
      maxChars: 5_000,
    });

    expect(result.text).toContain("Quarterly revenue rose");
    // Nothing was left out, so there is nothing to report.
    expect(result.note).toBeUndefined();
  });

  it("says how much of a PDF came back when it did not all fit", async () => {
    const result = await documentExtractor.extract({
      bytes: PDF_WITH_TEXT,
      mimeType: "application/pdf",
      name: "report.pdf",
      maxChars: 5,
    });

    // A hard cut is worse than a page boundary and far better than silence.
    expect(result.text.length).toBeLessThanOrEqual(5);
    expect(result.note).toContain("of 1");
  });

  it("reads plain text, including multi-byte", async () => {
    const result = await documentExtractor.extract({
      bytes: Buffer.from("# 제목\n본문입니다", "utf-8"),
      mimeType: "text/markdown",
      name: "notes.md",
      maxChars: 5_000,
    });

    expect(result.text).toBe("# 제목\n본문입니다");
  });

  it("reports how much text came back when it was cut", async () => {
    const result = await documentExtractor.extract({
      bytes: Buffer.from("abcdefghij", "utf-8"),
      mimeType: "text/plain",
      name: "a.txt",
      maxChars: 4,
    });

    expect(result.text).toBe("abcd");
    expect(result.note).toContain("first 4");
    expect(result.note).toContain("10");
  });

  it("refuses a text file that is not UTF-8 rather than handing back mojibake", async () => {
    await expect(
      documentExtractor.extract({
        bytes: Buffer.from("hello", "utf16le"),
        mimeType: "text/plain",
        name: "a.txt",
        maxChars: 5_000,
      }),
    ).rejects.toBeInstanceOf(DocumentExtractionError);
  });

  it("says a PDF is not a valid PDF rather than returning nothing", async () => {
    const error = await documentExtractor
      .extract({
        bytes: Buffer.from("not a pdf at all"),
        mimeType: "application/pdf",
        name: "broken.pdf",
        maxChars: 5_000,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DocumentExtractionError);
    // An empty success would read as "the document is empty", which is a
    // different and much more damaging answer.
    expect((error as Error).message).toMatch(/not a valid PDF|could not be parsed/);
  });

  it("refuses a file that is not a document at all", async () => {
    await expect(
      documentExtractor.extract({
        bytes: Buffer.from([0x50, 0x4b]),
        mimeType: "application/zip",
        name: "bundle.zip",
        maxChars: 5_000,
      }),
    ).rejects.toBeInstanceOf(DocumentExtractionError);
  });

  it("refuses when there is no room left, instead of returning an empty read", async () => {
    await expect(
      documentExtractor.extract({
        bytes: Buffer.from("text", "utf-8"),
        mimeType: "text/plain",
        name: "a.txt",
        maxChars: 0,
      }),
    ).rejects.toBeInstanceOf(DocumentExtractionError);
  });
});
