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
  const getVersion = vi.fn(async () => version);
  const getProject = vi.fn(async () => ({ ownerEmail: "owner@example.test" }));
  const deps = { projects: { get: getProject }, versions: { get: getVersion }, mcps: { get: async () => ({ name: "files" }) }, sourceRefreshIdentity: identity } as unknown as Parameters<typeof createMcpSourceRefresher>[0];
  const call = vi.fn(async () => {
    await vi.mocked(buildMcpTools).mock.calls[0]?.[0].registerMcpSource?.({ projectName: "audio", userEmail: "owner@example.test", namespace: "account", itemId: "42", url: "https://files.example.test/fresh", filename: "source", mimeType: "audio/mpeg" });
    return { text: "opaque projected result" };
  });
  const close = vi.fn(async () => {});
  vi.mocked(buildMcpTools).mockResolvedValue({ mcpTools: [{ type: "function", function: { name: "file_read", parameters: { properties: { file_id: { type: "integer" } } } } }],
    mcpServers: [], warnings: [], aliasFor: () => "file_read", callMcpTool: call, close });
  const job = { projectName: "audio", userEmail: "owner@example.test", sourceIdentity: { namespace: "account", itemId: "42" } } as AudioJob;
  return { run: createMcpSourceRefresher(deps), job, recipe, call, close, identity, getVersion, getProject };
}
describe("registered MCP source replay", () => {
  it("refreshes through the sub-agent binding and rejects ownership changes after the read", async () => {
    const f = fixture(); f.recipe.projectName = "downloader";
    await f.run(f.job, f.recipe, new AbortController().signal);
    expect(f.getVersion).toHaveBeenCalledWith("downloader", "1");
    expect(f.getProject).toHaveBeenCalledTimes(2);
    f.getProject.mockResolvedValueOnce({ ownerEmail: "owner@example.test" }).mockResolvedValueOnce({ ownerEmail: "new-owner@example.test" });
    await expect(f.run(f.job, f.recipe, new AbortController().signal)).rejects.toThrow("source_project_access_changed");
    expect(f.close).toHaveBeenCalledTimes(2);
  });
  it("uses the fixed read tool and projects privately before model-facing truncation without persisting a new reference", async () => {
    const f = fixture();
    const value = await f.run(f.job, f.recipe, new AbortController().signal);
    expect(value).toMatchObject({ itemId: "42", url: "https://files.example.test/fresh" });
    expect(f.call).toHaveBeenCalledExactlyOnceWith("file_read", { file_id: 42 });
    expect(vi.mocked(buildMcpTools).mock.calls[0]?.[1].mcpList).toEqual([{ name: "files", tools: ["get_file"], sourceOutputs: [{ ...f.recipe.mapping, refreshArgument: undefined }] }]);
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
