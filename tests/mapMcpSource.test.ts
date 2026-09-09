import { describe, expect, it, vi } from "vitest";
import { mapMcpSource, type RegisterMcpSource } from "@/application/audio/mapMcpSource";
import type { McpSourceMapping } from "@/domain/mcp/sourceMapping";

const mapping: McpSourceMapping = { tool: "get_file", namespace: "account", urlPath: ["file", "url"],
  idPath: ["file", "id"], namePath: ["file", "name"], mimeType: "audio/mpeg" };
const secret = "https://files.example.test/audio?signature=private";
const body = { file: { id: "item-1", name: "audio.mp3", url: secret }, alternate: secret, notes: `Download ${secret}` };
function input() {
  const register = vi.fn<RegisterMcpSource>(async (value) => ({ sourceRef: "ref-1", filename: value.filename, mimeType: value.mimeType }));
  return { mapping, register, serverName: "files", projectName: "audio", userEmail: "owner@example.test",
    result: { content: [{ type: "text", text: JSON.stringify(body) }] } };
}
describe("MCP source projection", () => {
  it("keeps the replay recipe private and refuses refresh mappings without a captured connection identity", async () => {
    const value = input(); const renewable = { ...mapping, refreshArgument: "file_id" };
    expect((await mapMcpSource({ ...value, mapping: renewable })).text).toMatch(/^Error:/);
    expect(value.register).not.toHaveBeenCalled();
    const refresh = { serverName: "files", versionName: "1", mapping: renewable, identity: "connection-generation" };
    const result = await mapMcpSource({ ...value, mapping: renewable, refresh });
    expect(value.register).toHaveBeenCalledWith(expect.objectContaining({ refresh }));
    expect(result.text).not.toContain("connection-generation");
    expect(result.text).not.toContain("refreshArgument");
  });
  it("returns only opaque file metadata and never copies alternate URLs or provider notes", async () => {
    const value = input(); const result = await mapMcpSource(value);
    expect(JSON.parse(result.text)).toEqual({ source_ref: "ref-1", filename: "audio.mp3", mime_type: "audio/mpeg", source: "files", external_id: "item-1" });
    expect(value.register).toHaveBeenCalledWith(expect.objectContaining({ url: secret, projectName: "audio", userEmail: "owner@example.test" }));
    expect(result.text).not.toContain("signature");
  });
  it("uses structured output without depending on a text preview", async () => {
    const value = input();
    expect((await mapMcpSource({ ...value, result: { structuredContent: body } })).text).toContain("ref-1");
  });
  it("separates namespaces from different MCP servers", async () => {
    const value = input(); await mapMcpSource(value); await mapMcpSource({ ...value, serverName: "another" });
    expect(value.register.mock.calls[0]?.[0].namespace).not.toBe(value.register.mock.calls[1]?.[0].namespace);
  });
  it("does not leak a raw response on invalid paths, failed registration or missing identity", async () => {
    const value = input();
    const missing = await mapMcpSource({ ...value, userEmail: undefined });
    const invalid = await mapMcpSource({ ...value, mapping: { ...mapping, idPath: ["constructor"] } });
    value.register.mockRejectedValueOnce(new Error(secret));
    const failed = await mapMcpSource(value);
    for (const result of [missing, invalid, failed]) { expect(result.text).toMatch(/^Error:/); expect(result.text).not.toContain("signature"); }
  });
  it("rejects a URL mapped into an identity field", async () => {
    const value = input();
    const result = await mapMcpSource({ ...value, mapping: { ...mapping, idPath: mapping.urlPath } });
    expect(result.text).toMatch(/^Error:/); expect(value.register).not.toHaveBeenCalled();
  });
});
