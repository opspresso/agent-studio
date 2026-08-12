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
