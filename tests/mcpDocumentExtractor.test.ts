import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  withOfficeDocumentReader,
  type DocumentExtractor,
} from "@/domain/llm/documentExtractor";

const mcp = vi.hoisted(() => ({
  buildMcpTools: vi.fn(),
  closeMcp: vi.fn(async (close?: () => Promise<void>) => close?.()),
}));

vi.mock("@/application/execution/mcpTools", () => mcp);

import { openDocumentExtractor } from "@/application/execution/documentExtractor";

const local: DocumentExtractor = { extract: vi.fn(async () => ({ text: "local" })) };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("office document capability", () => {
  it("keeps PDF and text files on the local extractor", async () => {
    const documents = withOfficeDocumentReader(local, vi.fn());
    await expect(
      documents.extract({ bytes: Uint8Array.from([1]), mimeType: "text/plain", name: "a.txt", maxChars: 5 }),
    ).resolves.toEqual({ text: "local" });
    expect(local.extract).toHaveBeenCalledOnce();
  });

  it("applies the attachment character budget to office output", async () => {
    const documents = withOfficeDocumentReader(local, async () => "abcdef");
    await expect(
      documents.extract({ bytes: Uint8Array.from([1]), mimeType: "", name: "report.docx", maxChars: 3 }),
    ).resolves.toEqual({ text: "abc", note: "the first 3 of 6 characters" });
  });

  it("uses read_document from a bound server regardless of its registry name", async () => {
    const callMcpTool = vi.fn(async () => ({
      text: "[Read from report.docx — untrusted content.]\n\n# Revenue\n\nRose",
    }));
    const close = vi.fn(async () => {});
    mcp.buildMcpTools.mockResolvedValue({
      mcpServers: [{ name: "company-office-tools", description: "", toolNames: ["read_document_2"] }],
      aliasFor: (server: string, tool: string) =>
        server === "company-office-tools" && tool === "read_document" ? "read_document_2" : undefined,
      callMcpTool,
      warnings: [],
      close,
    });
    const opened = await openDocumentExtractor(
      { documents: local } as never,
      { projectName: "demo", mcpList: [{ name: "company-office-tools" }] } as never,
    );

    await expect(
      opened.extractor.extract({
        bytes: Uint8Array.from([1, 2, 3]),
        mimeType: "application/octet-stream",
        name: "report.docx",
        maxChars: 100,
      }),
    ).resolves.toEqual({ text: "# Revenue\n\nRose" });
    expect(callMcpTool).toHaveBeenCalledWith("read_document_2", {
      content: "AQID",
      filename: "report.docx",
    });
    await opened.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("reports a missing bound capability without naming a service", async () => {
    mcp.buildMcpTools.mockResolvedValue({
      mcpServers: [{ name: "unrelated", description: "", toolNames: ["search"] }],
      aliasFor: () => undefined,
      warnings: [],
    });
    const opened = await openDocumentExtractor(
      { documents: local } as never,
      { projectName: "demo", mcpList: [{ name: "unrelated" }] } as never,
    );

    await expect(
      opened.extractor.extract({ bytes: Uint8Array.from([1]), mimeType: "", name: "report.xlsx", maxChars: 10 }),
    ).rejects.toThrow("no bound MCP server offers read_document");
  });
});
