import { describe, expect, it } from "vitest";
import { formatToolResult } from "@/infrastructure/mcp/toolManager";

/**
 * Turning a server's content blocks into one tool result, at the unit.
 *
 * `mcpBinaryResource.test.ts` exercises the same path through a real
 * `ToolManager`, which is the right level for "does a PDF survive the round
 * trip". The caps below cannot be reached that way: `MAX_MCP_RESPONSE_BYTES`
 * bounds the whole JSON-RPC envelope, and base64 inflates by 4/3, so a blob at
 * the file cap is refused by the transport long before this function sees it.
 * That ceiling is real and deliberate — a server with something bigger to hand
 * over has to say so itself rather than have the envelope cut, since a truncated
 * envelope arrives as a parse failure that says nothing about the document.
 */

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const blobOf = (bytes: number[]) => Buffer.from(bytes).toString("base64");

function resource(over: Record<string, unknown>) {
  return [{ type: "resource", resource: over }];
}

describe("files in a tool result", () => {
  it("names a file from its uri", () => {
    const blob = blobOf([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe]);
    const result = formatToolResult(
      resource({ uri: "file:///out/보고서.docx", mimeType: DOCX, blob }),
    );
    expect(result.files).toEqual([{ b64: blob, mimeType: DOCX, name: "보고서.docx" }]);
    // The text still stands in for it: a `tool` message carries text only.
    expect(result.text).toContain("보고서.docx");
    expect(result.text).toContain("delivered to the user");
  });

  it("falls back to the mime subtype when the uri names nothing", () => {
    const result = formatToolResult(
      resource({ mimeType: "application/pdf", blob: blobOf([0x00, 0xff, 0x00]) }),
    );
    expect(result.files?.[0]?.name).toBe("file.pdf");
  });

  it("drops a query string rather than putting it in a filename", () => {
    const result = formatToolResult(
      resource({
        uri: "https://x.test/a/report.docx?sig=abc",
        mimeType: DOCX,
        // Has to be genuinely binary: `[1, 2]` is valid UTF-8, so the decode
        // above would claim it as text and never reach the file branch.
        blob: blobOf([0x00, 0xff]),
      }),
    );
    expect(result.files?.[0]?.name).toBe("report.docx");
  });

  it("omits a blob too large to carry, in the shape it always did", () => {
    const blob = Buffer.alloc(10_500_001, 0xff).toString("base64");
    const result = formatToolResult(resource({ uri: "file:///big.bin", mimeType: DOCX, blob }));
    expect(result.files).toBeUndefined();
    expect(result.text).toContain("binary resource omitted");
  });

  it("bounds how many files one result may carry", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      type: "resource",
      resource: { uri: `file:///f${i}.docx`, mimeType: DOCX, blob: blobOf([0x00, 0xff]) },
    }));
    expect(formatToolResult(many).files).toHaveLength(4);
  });

  /**
   * Each file block writes "delivered to the user" into its own text. Cutting
   * the list afterwards left those notes standing for files nobody received —
   * so the model told the reader about six documents and four existed.
   */
  it("says which files it dropped rather than leaving their delivery notes standing", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      type: "resource",
      resource: { uri: `file:///f${i}.docx`, mimeType: DOCX, blob: blobOf([0x00, 0xff]) },
    }));

    const result = formatToolResult(many);

    expect(result.text).toContain("file omitted: f4.docx");
    expect(result.text).toContain("file omitted: f5.docx");
    // And the four that made it still read as delivered.
    expect(result.text.match(/delivered to the user/g)).toHaveLength(4);
  });

  it("keeps a dropped file's note out of the way of the ones that arrived", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      type: "resource",
      resource: { uri: `file:///f${i}.docx`, mimeType: DOCX, blob: blobOf([0x00, 0xff]) },
    }));

    const result = formatToolResult(many);

    expect(result.files?.map((file) => file.name)).toEqual([
      "f0.docx",
      "f1.docx",
      "f2.docx",
      "f3.docx",
    ]);
  });

  /**
   * `decodeURIComponent` throws on a lone `%`, and this runs while formatting a
   * call that *succeeded* — inside the catch that turns anything thrown into
   * `Error: tool call failed`. The server rendered the document; the client
   * reported a failure and dropped it.
   */
  it("survives a uri the decoder refuses", () => {
    const blob = blobOf([0x00, 0xff]);
    const result = formatToolResult(
      resource({ uri: "file:///out/report%.docx", mimeType: DOCX, blob }),
    );
    expect(result.files?.[0]?.name).toBe("report%.docx");
    expect(result.text).not.toContain("Error");
  });

  it("takes control characters out of a name that is going to be shown", () => {
    const name = `a${String.fromCharCode(10)}b.docx`;
    const result = formatToolResult(
      resource({
        uri: `file:///${encodeURIComponent(name)}`,
        mimeType: DOCX,
        blob: blobOf([0x00, 0xff]),
      }),
    );
    expect(result.files?.[0]?.name).toBe("ab.docx");
  });

  it("does not let a name claim a directory that does not exist", () => {
    // The object key comes from a UUID, so nothing is traversable — but a name
    // rendered with slashes in it says otherwise to whoever reads the reply.
    const result = formatToolResult(
      resource({
        uri: `file:///out/${encodeURIComponent("../../etc/passwd")}`,
        mimeType: DOCX,
        blob: blobOf([0x00, 0xff]),
      }),
    );
    expect(result.files?.[0]?.name).toBe(".._.._etc_passwd");
  });

  it("bounds a name's length and keeps the extension across the cut", () => {
    const long = `${"a".repeat(400)}.docx`;
    const result = formatToolResult(
      resource({ uri: `file:///${long}`, mimeType: DOCX, blob: blobOf([0x00, 0xff]) }),
    );
    const name = result.files?.[0]?.name ?? "";
    expect(name.length).toBeLessThanOrEqual(120);
    expect(name.endsWith(".docx")).toBe(true);
  });

  it("falls back when the segment sanitises away to nothing", () => {
    const result = formatToolResult(
      resource({ uri: "file:///out/../", mimeType: "application/pdf", blob: blobOf([0x00, 0xff]) }),
    );
    expect(result.files?.[0]?.name).toBe("file.pdf");
  });

  /**
   * The count budget downstream bounds how many images a turn carries and has
   * never had anything to say about how large one is. Only the upload path
   * checked the byte cap — which is a bound providers impose, so where the
   * picture came from cannot change it. The cost of skipping it was the whole
   * turn: the image rides on the next user message, and a provider refusing it
   * fails the request rather than the picture.
   */
  it("refuses an image no provider would accept, and says so", () => {
    const blob = Buffer.alloc(5 * 1024 * 1024 + 1, 0x41).toString("base64");
    const result = formatToolResult(
      resource({ uri: "file:///huge.png", mimeType: "image/png", blob }),
    );
    expect(result.images).toBeUndefined();
    expect(result.files).toBeUndefined();
    expect(result.text).toContain("image omitted");
    expect(result.text).toContain("smaller rendition");
  });

  it("keeps an image at the limit", () => {
    const blob = Buffer.alloc(5 * 1024 * 1024, 0x41).toString("base64");
    const result = formatToolResult(
      resource({ uri: "file:///big.png", mimeType: "image/png", blob }),
    );
    expect(result.images).toHaveLength(1);
  });

  /**
   * `data:image/png; charset=binary;base64,…` is not a valid data URL, and the
   * turn the picture rides on is what fails. The same string was also the
   * artifact's media type, where nothing matched it and the object was stored
   * as `.bin`.
   */
  it("takes a media type's parameters off before anything is built from it", () => {
    const blob = blobOf([0x89, 0x50, 0x4e, 0x47]);
    const result = formatToolResult(
      resource({ uri: "file:///a.png", mimeType: "IMAGE/PNG; charset=binary", blob }),
    );
    expect(result.images).toEqual([{ b64: blob, mimeType: "image/png" }]);
  });

  it("reads a file's declared type the same way", () => {
    const result = formatToolResult(
      resource({
        uri: "file:///a.docx",
        mimeType: `${DOCX}; charset=binary`,
        blob: blobOf([0x00, 0xff]),
      }),
    );
    expect(result.files?.[0]?.mimeType).toBe(DOCX);
  });

  it("leaves an image an image", () => {
    const blob = blobOf([0x89, 0x50, 0x4e, 0x47]);
    const result = formatToolResult(resource({ uri: "file:///a.png", mimeType: "image/png", blob }));
    expect(result.images).toEqual([{ b64: blob, mimeType: "image/png" }]);
    expect(result.files).toBeUndefined();
  });

  it("is decided on the bytes, not the declared type", () => {
    const blob = Buffer.from("just words", "utf-8").toString("base64");
    const result = formatToolResult(
      resource({ uri: "file:///a.bin", mimeType: "application/octet-stream", blob }),
    );
    expect(result.files).toBeUndefined();
    expect(result.text).toBe("just words");
  });
});
