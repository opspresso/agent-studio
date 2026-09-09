import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpSourceRefresher } from "@/application/execution/refreshMcpSource";
import { buildMcpTools } from "@/application/execution/mcpTools";
import type { AudioJob } from "@/domain/audio/job";
import type { SourceRefresh } from "@/domain/artifact/sourceReference";
vi.mock("@/application/execution/mcpTools", () => ({ buildMcpTools: vi.fn(), closeMcp: async (close?: () => Promise<void>) => close?.() }));
beforeEach(() => vi.clearAllMocks());
function fixture() {
  const recipe: SourceRefresh = { serverName: "files", versionName: "1", identity: "epoch-1", mapping: {
    tool: "get_file", namespace: "account", idPath: ["id"], urlPath: ["url"], mimeType: "audio/mpeg", refreshArgument: "file_id",
  } };
  const version = { projectName: "audio", versionName: "1", mcpList: [{ name: "files", sourceOutputs: [recipe.mapping] }] };
  const identity = vi.fn(async () => "epoch-1");
  const deps = { versions: { get: async () => version }, mcps: { get: async () => ({ name: "files" }) }, sourceRefreshIdentity: identity } as unknown as Parameters<typeof createMcpSourceRefresher>[0];
  const call = vi.fn(async () => ({ text: JSON.stringify({ id: 42, url: "https://files.example.test/fresh" }) }));
  const close = vi.fn(async () => {});
  vi.mocked(buildMcpTools).mockResolvedValue({ mcpTools: [{ type: "function", function: { name: "file_read", parameters: { properties: { file_id: { type: "integer" } } } } }],
    mcpServers: [], warnings: [], aliasFor: () => "file_read", callMcpTool: call, close });
  const job = { projectName: "audio", userEmail: "owner@example.test", sourceIdentity: { namespace: "account", itemId: "42" } } as AudioJob;
  return { run: createMcpSourceRefresher(deps), job, recipe, call, close, identity };
}
describe("registered MCP source replay", () => {
  it("uses only the fixed read tool and typed original ID, without recursively projecting the response", async () => {
    const f = fixture();
    const value = await f.run(f.job, f.recipe, new AbortController().signal);
    expect(value).toMatchObject({ itemId: "42", url: "https://files.example.test/fresh" });
    expect(f.call).toHaveBeenCalledExactlyOnceWith("file_read", { file_id: 42 });
    expect(vi.mocked(buildMcpTools).mock.calls[0]?.[1].mcpList).toEqual([{ name: "files", tools: ["get_file"], sourceOutputs: undefined }]);
    expect(f.close).toHaveBeenCalledTimes(1);
  });
  it("refuses reconnections before issuing the read", async () => {
    const f = fixture(); f.identity.mockResolvedValue("new-account");
    await expect(f.run(f.job, f.recipe, new AbortController().signal)).rejects.toThrow("source_connection_changed");
    expect(buildMcpTools).not.toHaveBeenCalled(); expect(f.call).not.toHaveBeenCalled();
  });
  it("rechecks connection identity after the read and closes the session on a concurrent reconnect", async () => {
    const f = fixture(); f.identity.mockResolvedValueOnce("epoch-1").mockResolvedValueOnce("new-account");
    await expect(f.run(f.job, f.recipe, new AbortController().signal)).rejects.toThrow("source_connection_changed");
    expect(f.close).toHaveBeenCalledTimes(1);
  });
});
