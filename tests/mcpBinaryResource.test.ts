/**
 * What a tool result does with a non-image `resource.blob`.
 *
 * The bug this pins: the decode sat inside a `try/catch` whose catch could never
 * run. `Buffer.toString("utf-8")` does not throw on arbitrary bytes — invalid
 * sequences become U+FFFD — so a PDF returned by an MCP server reached the model
 * as a page of replacement characters, presented as a successful result. The
 * "Unsupported binary resource" message the catch was supposed to produce had
 * never once been emitted.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/infrastructure/net/publicFetch", () => ({
  fetchPublicUrl: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
}));

import { ToolManager } from "@/infrastructure/mcp/toolManager";
import { clearMcpDiscoveryCache } from "@/infrastructure/mcp/discoveryCache";
import { conforming, modernResult, protocolPreamble } from "./mcpProtocolStub";

const SERVER = { name: "files", url: "https://mcp.example.com/mcp", headers: {} };

/** A server offering one tool, whose call returns `content`. */
function stubServer(content: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; id?: number };
      const preamble = protocolPreamble(body.method, body.id, init?.method);
      if (preamble) {
        return preamble;
      }
      const result = modernResult(body.method, {
        ...(body.method === "tools/list"
          ? { tools: conforming([{ name: "read_file", description: "" }]) }
          : { content }),
      });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result }), {
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

async function callWith(content: unknown[]) {
  stubServer(content);
  const manager = new ToolManager([SERVER]);
  await manager.init();
  return manager.callTool("read_file", {});
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearMcpDiscoveryCache();
});

describe("a resource blob that is not an image", () => {
  it("never returns replacement characters for a PDF", async () => {
    const pdf = Buffer.from("255044462d312e340a25e2e3cfd3", "hex").toString("base64");

    const result = await callWith([
      {
        type: "resource",
        // `uri` is required of an embedded resource, and the whole result is
        // validated — omitting it scripts a refused answer, not a nameless file.
        resource: { uri: "file:///doc.pdf", blob: pdf, mimeType: "application/pdf" },
      },
    ]);

    // The original defect, still pinned: a decode that cannot fail turned this
    // into a page of U+FFFD presented as a successful result.
    expect(result.text).not.toContain("\uFFFD");
    // And now it is carried rather than dropped — the file is the answer.
    expect(result.files).toEqual([
      // Named from the resource's own uri, which it now carries.
      { b64: pdf, mimeType: "application/pdf", name: "doc.pdf" },
    ]);
    expect(result.text).toContain("14 bytes");
  });

  it("decides on the bytes, not on a content type the server got wrong", async () => {
    // Servers label real text `application/octet-stream` routinely. Refusing on
    // the declared type would lose a result that is perfectly readable.
    const result = await callWith([
      {
        type: "resource",
        resource: {
          uri: "file:///data",
          blob: Buffer.from("id,name\n1,bruce", "utf-8").toString("base64"),
          mimeType: "application/octet-stream",
        },
      },
    ]);

    expect(result.text).toBe("id,name\n1,bruce");
  });

  it("reads multi-byte text back unchanged", async () => {
    const result = await callWith([
      {
        type: "resource",
        resource: {
          uri: "file:///data",
          blob: Buffer.from("제목: 보고서", "utf-8").toString("base64"),
          mimeType: "text/plain",
        },
      },
    ]);

    expect(result.text).toBe("제목: 보고서");
  });

  it("still lets a readable block through when another is binary", async () => {
    const result = await callWith([
      { type: "text", text: "here is the file" },
      {
        type: "resource",
        resource: {
          uri: "file:///archive.zip",
          blob: Buffer.from([0x00, 0x01, 0x02]).toString("base64"),
          mimeType: "application/zip",
        },
      },
    ]);

    // Multi-block results are JSON-joined, so the file's placeholder has to
    // compose rather than claim the whole call failed.
    expect(result.text).toContain("here is the file");
    expect(result.text).toContain("delivered to the user");
  });
});
