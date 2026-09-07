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

  it("reads HTML as its own kind, ahead of the text branch", () => {
    // `text/html` satisfies the text rule too, so order is what decides this.
    // Handed over as text, a page is mostly markup the model reads past.
    expect(documentKind("text/html", "page.html")).toBe("html");
    expect(documentKind("application/xhtml+xml", "page.xhtml")).toBe("html");
    expect(documentKind("", "saved.htm")).toBe("html");
    expect(documentKind("application/octet-stream", "saved.html")).toBe("html");
  });

  it("routes the office formats the native engine reads", () => {
    expect(documentKind("", "report.docx")).toBe("office");
    expect(documentKind("application/octet-stream", "deck.pptx")).toBe("office");
    expect(documentKind("application/vnd.hancom.hwp", "report")).toBe("office");
    expect(documentKind("application/vnd.oasis.opendocument.spreadsheet", "sheet")).toBe(
      "office",
    );
    expect(documentKind("text/rtf", "notes.rtf")).toBe("office");
  });

  it("does not offer unsupported legacy Office binaries", () => {
    expect(documentKind("application/msword", "report.doc")).toBeNull();
    expect(documentKind("application/vnd.ms-excel", "sheet.xls")).toBeNull();
    expect(documentKind("application/vnd.ms-powerpoint", "deck.ppt")).toBeNull();
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

/** Page 1 blank, page 2 with text — the cover-sheet shape. */
const PDF_BLANK_FIRST_PAGE = Buffer.from(
  `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R 6 0 R]/Count 2>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<<>>>>endobj
4 0 obj<</Length 0>>stream

endstream
endobj
6 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 7 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
7 0 obj<</Length 52>>stream
BT /F1 12 Tf 20 100 Td (Second page carries the text) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>`,
  "latin1",
);

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

  it("never returns an empty document with a confident page note", async () => {
    // The failure this guards: a blank leading page (a cover sheet, a scanned
    // divider) costs nothing, so the page loop keeps it and then breaks on the
    // page that does not fit. `kept` is non-empty and the old fallback never
    // ran, so the model got a framed block with nothing in it while the reader
    // was told "Read the first 1 of 3 pages".
    const result = await documentExtractor.extract({
      bytes: PDF_BLANK_FIRST_PAGE,
      mimeType: "application/pdf",
      name: "cover.pdf",
      maxChars: 12,
    });

    expect(result.text.trim()).not.toBe("");
    expect(result.note).toContain("itself cut at");
  });

  it("cuts extracted text without splitting a character", async () => {
    const result = await documentExtractor.extract({
      bytes: Buffer.from("a".repeat(9) + "\u{1F600}" + "tail", "utf-8"),
      mimeType: "text/plain",
      name: "emoji.txt",
      maxChars: 10,
    });

    // A naive slice(0, 10) lands between the two halves of the emoji.
    expect(result.text.isWellFormed()).toBe(true);
    expect(result.text).toBe("a".repeat(9));
    // The note reports what actually came back, not the limit that was asked for.
    expect(result.note).toContain("first 9");
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

  it("takes the markup off an attached page", async () => {
    // An HTML attachment must reach the model as extracted prose, not raw
    // markup merely because `documentKind` classifies it as text-like.
    const result = await documentExtractor.extract({
      bytes: Buffer.from(
        "<title>Report</title><body><script>var x=1</script><p>Revenue rose.</p></body>",
        "utf-8",
      ),
      mimeType: "text/html",
      name: "page.html",
      maxChars: 1000,
    });
    expect(result.text).toBe("Report\n\nRevenue rose.");
  });

  it("refuses a page whose text only exists after scripts run", async () => {
    // Empty output would read as "the page said nothing" — a different claim.
    await expect(
      documentExtractor.extract({
        bytes: Buffer.from("<body><script>render()</script></body>", "utf-8"),
        mimeType: "text/html",
        name: "app.html",
        maxChars: 1000,
      }),
    ).rejects.toBeInstanceOf(DocumentExtractionError);
  });

  it("follows a declared charset only when one was passed", async () => {
    // EUC-KR bytes for "한글". An upload never declares an encoding, so it takes
    // the UTF-8 path and is refused — which is right: the person can re-save it.
    const eucKr = Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]);
    await expect(
      documentExtractor.extract({
        bytes: eucKr,
        mimeType: "text/html",
        name: "page.html",
        maxChars: 1000,
      }),
    ).rejects.toBeInstanceOf(DocumentExtractionError);

    // A fetched page can say so, and a remote server is not something the
    // caller can go and fix.
    const declared = await documentExtractor.extract({
      bytes: Buffer.concat([Buffer.from("<p>"), eucKr, Buffer.from("</p>")]),
      mimeType: "text/html",
      name: "page.html",
      maxChars: 1000,
      charset: "euc-kr",
    });
    expect(declared.text).toBe("한글");
  });

  it("leaves a plain text attachment exactly as it was", async () => {
    // The charset argument must not change the path an upload takes: no caller
    // on the attachment side passes one, and this is what pins that.
    const result = await documentExtractor.extract({
      bytes: Buffer.from("plain body", "utf-8"),
      mimeType: "text/plain",
      name: "a.txt",
      maxChars: 1000,
    });
    expect(result).toEqual({ text: "plain body" });
  });
});
