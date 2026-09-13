import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildMcpTools, type McpToolDeps } from "@/application/execution/mcpTools";
import type { McpSourceMapping } from "@/domain/mcp/sourceMapping";
import type { McpServer } from "@/domain/mcp/types";
import type { Version } from "@/domain/project/types";
import { clearMcpDiscoveryCache } from "@/infrastructure/mcp/discoveryCache";
import { mcpSessionFactory } from "@/infrastructure/mcp/sessionFactory";
import { conforming, modernResult, protocolPreamble } from "./mcpProtocolStub";

vi.mock("@/infrastructure/net/publicFetch", () => ({
  fetchPublicUrl: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
}));

const mapping: McpSourceMapping = { tool: "get_file", namespace: "recordings", urlPath: ["presigned_url"],
  idPath: ["id"], namePath: ["name"], mimeType: "audio/mpeg", refreshArgument: "file_id" };
const schema = { type: "object", properties: { file_id: { type: "string" } }, required: ["file_id"], additionalProperties: false };
const description = "Read recording details and a temporary download URL.";
const sourceUrl = "https://files.example.test/audio?signature=private";

function fixture() {
  const servers: McpServer[] = ["documents", "recordings"].map((name) => ({
    name, url: `https://${name}.example.test/mcp`, headers: {}, createdAt: "before", updatedAt: "before",
    ...(name === "recordings" ? { sourceOutputs: [mapping] } : {}),
  }));
  const register = vi.fn(async () => ({ sourceRef: "private-source", filename: "meeting", mimeType: "audio/mpeg" }));
  const deps = {
    mcps: { get: async (name: string) => servers.find((server) => server.name === name) ?? null },
    cipher: { mergeOutboundHeaders: () => ({}) }, urlPolicy: { assertAllowed: async () => {} },
    sourceRefreshIdentity: async () => "connection-1", registerMcpSource: register, mcpSessions: mcpSessionFactory,
  } as unknown as McpToolDeps;
  const version = { projectName: "audio", versionName: "1", mcpList: servers.map(({ name }) => ({ name })) } as Version;
  const open = (bindings = version.mcpList) => buildMcpTools(deps, { ...version, mcpList: bindings }, undefined,
    { actor: { kind: "user", id: "owner@example.test" } });
  return { open, register, version };
}

beforeEach(() => {
  clearMcpDiscoveryCache();
  vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body ?? "{}"));
    const preamble = protocolPreamble(request.method, request.id, init?.method);
    if (preamble) return preamble;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: modernResult(request.method,
      request.method === "tools/list"
        ? { tools: conforming([{ name: "get_file", description, inputSchema: schema }, { name: "list_files", description: "List recordings." }]) }
        : { content: [{ type: "text", text: JSON.stringify({ id: "recording-1", name: "meeting", presigned_url: sourceUrl }) }] }),
    }), { headers: { "content-type": "application/json" } });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); clearMcpDiscoveryCache(); });

describe("mapped MCP tools offered to an Agent", () => {
  it("advertises and returns the private reference only for the mapped alias, preserving provider inputs", async () => {
    const f = fixture();
    const run = await f.open();
    try {
      const alias = run.aliasFor!("recordings", "get_file")!;
      expect(alias).not.toBe(run.aliasFor!("documents", "get_file"));
      const mapped = run.mcpTools.find((tool) => tool.function.name === alias)!.function;
      expect(mapped.description).toContain(description);
      expect(mapped.description).toContain("source_ref");
      expect(mapped.description).toContain('"kind":"source"');
      expect(mapped.parameters).toEqual(schema);
      for (const tool of run.mcpTools.filter((tool) => tool.function.name !== alias)) {
        expect(tool.function.description).not.toContain("source_ref");
      }
      const result = await run.callMcpTool!(alias, { file_id: "recording-1" });
      expect(JSON.parse(result.text)).toMatchObject({ source_ref: "private-source", external_id: "recording-1" });
      expect(result.text).not.toContain(sourceUrl);
      expect(f.register).toHaveBeenCalledWith(expect.objectContaining({ url: sourceUrl,
        refresh: expect.objectContaining({ identity: "connection-1" }) }));
    } finally { await run.close?.(); }
  });

  it("does not retain projection instructions in cached discovery after an explicit empty override", async () => {
    const f = fixture();
    const mapped = await f.open();
    await mapped.close?.();
    const raw = await f.open([{ name: "documents" }, { name: "recordings", sourceOutputs: [] }]);
    try {
      expect(raw.mcpTools.every((tool) => !tool.function.description?.includes("source_ref"))).toBe(true);
      expect(raw.signature).not.toBe(mapped.signature);
    } finally { await raw.close?.(); }
  });

  it("follows the effective override instead of documenting a disabled default mapping", async () => {
    const f = fixture();
    const run = await f.open([{ name: "recordings", sourceOutputs: [{ ...mapping, tool: "list_files" }] }]);
    try {
      expect(run.mcpTools.find((tool) => tool.function.name === "get_file")!.function.description).toBe(description);
      expect(run.mcpTools.find((tool) => tool.function.name === "list_files")!.function.description).toContain("source_ref");
    } finally { await run.close?.(); }
  });
});
