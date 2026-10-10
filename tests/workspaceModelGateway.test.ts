import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceModelGateway } from "@/application/workspace/modelGateway";
import { createWorkspaceModelTokens } from "@/infrastructure/workspace/modelToken";
import { createWorkspaceModelTransport } from "@/infrastructure/workspace/modelTransport";
import { workspaceModelCalls } from "@/infrastructure/db/repositories/workspaceModelCalls";
import { usageRepository } from "@/infrastructure/db/repositories/usageRepository";
import type { createFakeStore } from "./fakeStore";
import * as store from "@/infrastructure/db/store";
import { keys } from "@/infrastructure/db/keys";
import { interactiveIdentity } from "./runIdentity";
import type { Workspace, WorkspaceRun } from "@/domain/workspace/types";
import type { WorkspaceModelTransport } from "@/domain/workspace/modelGateway";
import { listModels, replaceModelRegistry } from "@/domain/llm/models";

vi.mock("@/infrastructure/db/store", async () => (await import("./fakeStore")).createFakeStore());
const fake = store as unknown as ReturnType<typeof createFakeStore>;
const original = listModels();
const now = new Date("2026-10-02T00:00:00Z");
beforeEach(() => { fake.rows.clear(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now); vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
  replaceModelRegistry([{ id: "selfhosted/native", provider: "selfhosted", family: "test", maker: "test", displayName: "Native",
    pricing: { inputPer1M: 1, outputPer1M: 2 }, contextWindow: 100000, maxTokens: 10000,
    capabilities: { tools: true, imageInput: false, structuredOutput: false, reasoning: false } }]); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); replaceModelRegistry(original); });
async function fixture() {
  const identity = interactiveIdentity("caller@example.test", "caller-id");
  const workspace = { id: "ws", runtime: "codex", agentName: "agent", ownerEmail: identity.user.email, status: "active", activeRunId: "run" } as Workspace;
  const run = { ...identity, id: "run", workspaceId: "ws", status: "running", phase: "runtime", operationId: "run", startedAt: now.toISOString() } as WorkspaceRun;
  const agent = { name: "agent", ownerEmail: identity.user.email };
  fake.seed([{ ...keys.agent("agent"), ...agent, entityType: "AGENT" }]);
  const transport: WorkspaceModelTransport = { forward: vi.fn(async input => {
    await input.finish({ inputTokens: 10, outputTokens: 2, cachedTokens: 0, reasoningTokens: 0, costUsd: 0.5 }, true);
    return Response.json({ result: "done" });
  }) };
  const tokens = createWorkspaceModelTokens(Buffer.alloc(32, 3));
  let sequence = 0;
  const deps = { workspaces: { get: async () => workspace, run: async () => run }, agents: { get: async () => agent },
    calls: workspaceModelCalls, tokens, transport, selection: async () => ({ model: "selfhosted/native", wireModel: "native", protocol: "responses" as const }),
    authorize: vi.fn(async () => {}), limits: async () => ({ monthlyCostCapUsd: 1 }), pricingPolicy: async () => "refuse" as const,
    usage: usageRepository, now: () => now, newId: () => "request-" + ++sequence, runTimeoutMs: 60_000,
  } as unknown as Parameters<typeof createWorkspaceModelGateway>[0];
  const gateway = createWorkspaceModelGateway(deps);
  const { token } = await gateway.credential(workspace, run);
  return { workspace, run, deps, gateway, transport, token,
    call: (path = "v1/responses", body = { model: "native" }) => gateway.forward(token, path, body, {}, new AbortController().signal) };
}
describe("run-scoped native model gateway", () => {
  it("settles measured throughput once when accounting completion is repeated", async () => {
    const f = await fixture();
    vi.mocked(f.transport.forward).mockImplementationOnce(async input => {
      const measured = { inputTokens: 10, outputTokens: 20, cachedTokens: 0, reasoningTokens: 0, costUsd: 0.1, modelDurationMs: 500 };
      await input.finish(measured, true);
      await input.finish(measured, true);
      return Response.json({ result: "done" });
    });
    await f.call();
    const rows = await usageRepository.listMemberDays("caller-id", "2026-10-02", "2026-10-02");
    expect(rows[0]).toMatchObject({ calls: { "selfhosted/native": 1 }, modelDurationMs: { "selfhosted/native": 500 },
      timedOutputTokens: { "selfhosted/native": 20 }, timedCalls: { "selfhosted/native": 1 } });
  });
  it.each([
    { protocol: "responses" as const, item: { type: "function_call_output", call_id: "call", output: [{ type: "input_file", file_id: "foreign-file" }] } },
    { protocol: "responses" as const, item: { type: "function_call_output", call_id: "call", output: [{ type: "input_image", file_id: "foreign-image" }] } },
    { protocol: "messages" as const, item: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu", content: [
      { type: "document", source: { type: "file", file_id: "foreign-file" } },
    ] }] } },
    { protocol: "messages" as const, item: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu", content: [
      { type: "image", source: { type: "file", file_id: "foreign-image" } },
    ] }] } },
    { protocol: "messages" as const, item: { role: "user", content: [{ type: "document", source: { type: "content", content: [
      { type: "image", source: { type: "file", file_id: "foreign-image" } },
    ] } }] } },
  ])("rejects nested provider resource references in $protocol tool results", async ({ protocol, item }) => {
    const f = await fixture();
    f.workspace.runtime = protocol === "messages" ? "claude" : "codex";
    f.deps.selection = async () => ({ model: "selfhosted/native", wireModel: "native", protocol });
    const { token } = await f.gateway.credential(f.workspace, f.run);
    await expect(f.gateway.forward(token, "v1/" + protocol, {
      model: "native", [protocol === "responses" ? "input" : "messages"]: [item],
    }, {}, new AbortController().signal)).rejects.toMatchObject({ status: 403 });
    expect(f.transport.forward).not.toHaveBeenCalled();
    expect(await workspaceModelCalls.get("ws", "run")).toBeNull();
  });

  it.each(["responses", "messages"] as const)("keeps inline results and ordinary tool arguments in %s", async protocol => {
    const f = await fixture();
    f.workspace.runtime = protocol === "messages" ? "claude" : "codex";
    f.deps.selection = async () => ({ model: "selfhosted/native", wireModel: "native", protocol });
    const { token } = await f.gateway.credential(f.workspace, f.run);
    const context = protocol === "responses" ? { input: [
      { type: "function_call", call_id: "call", name: "read_file", arguments: JSON.stringify({ file_id: "local-value" }) },
      { type: "function_call_output", call_id: "call", output: [{ type: "input_file", filename: "local.txt", file_data: "data:text/plain;base64,aGVsbG8=" }] },
    ] } : { messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "toolu", name: "read_file", input: { file_id: "local-value" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu", content: [
        { type: "document", source: { type: "content", content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
        ] } },
      ] }] },
    ] };
    const response = await f.gateway.forward(token, "v1/" + protocol, { model: "native", ...context }, {}, new AbortController().signal);
    expect(response.ok).toBe(true);
    expect(f.transport.forward).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining(context) }));
  });

  it.each(["messages", "chat/completions"] as const)("rejects provider file and audio references in %s messages", async protocol => {
    const f = await fixture();
    f.workspace.runtime = protocol === "messages" ? "claude" : "opencode";
    f.deps.selection = async () => ({ model: "selfhosted/native", wireModel: "native", protocol });
    const { token } = await f.gateway.credential(f.workspace, f.run);
    for (const message of [{ role: "user", content: [{ type: "file", file: { file_id: "foreign-file" } }] },
      { role: "assistant", audio: { id: "foreign-audio" } }, { role: "user", content: [{ type: "document", source: { type: "file", file_id: "foreign-file" } }] }]) {
      await expect(f.gateway.forward(token, "v1/" + protocol, { model: "native", messages: [message] }, {}, new AbortController().signal)).rejects.toMatchObject({ status: 403 });
    }
    expect(f.transport.forward).not.toHaveBeenCalled();
  });
  it("returns the original result after the accounting DELETE committed but its acknowledgement was lost", async () => {
    const f = await fixture();
    const finish = f.deps.calls.finish;
    vi.spyOn(f.deps.calls, "finish").mockImplementationOnce(async call => { await finish(call); throw new Error("Lost acknowledgement"); });
    f.deps.transport = createWorkspaceModelTransport(async () => ({ providerName: "selfhosted", auth: "bearer", apiKey: "fixture",
      baseUrl: "https://provider.example.test/v1", model: "native" }));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ object: "response", status: "completed", error: null,
      usage: { input_tokens: 10, output_tokens: 2, cost: 0.5 }, output: [] })));
    const response = await f.call();
    expect(response.ok).toBe(true);
    expect(await response.json()).toMatchObject({ status: "completed" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await workspaceModelCalls.get("ws", "run")).toBeNull();
    expect((await usageRepository.listMemberDays(f.run.user.userId, "2026-10-02", "2026-10-02"))[0]?.calls["selfhosted/native"]).toBe(1);
  });
  it("refuses references to shared provider context and uses stateless native history", async () => {
    const f = await fixture();
    for (const extra of [{ previous_response_id: "foreign-response" }, { conversation: "foreign-conversation" },
      { input: [{ type: "item_reference", id: "foreign-item" }] }, { input: [{ id: "foreign-item" }] },
      { input: [{ id: "foreign-item", type: null }] }, { prompt: { id: "foreign-prompt" } }, { tools: [{ type: "file_search", vector_store_ids: ["foreign-store"] }] },
      { input: [{ role: "user", content: [{ type: "input_file", file_id: "foreign-file" }] }] }]) {
      await expect(f.gateway.forward(f.token, "v1/responses", { model: "native", ...extra }, {}, new AbortController().signal)).rejects.toMatchObject({ status: 403 });
    }
    expect(f.transport.forward).not.toHaveBeenCalled();
    await f.call();
    expect(f.transport.forward).toHaveBeenCalledWith(expect.objectContaining({ body: { model: "native", store: false } }));
  });
  it("records every helper request to the original Studio user and enforces the shared budget", async () => {
    const f = await fixture(); await f.call(); await f.call();
    await expect(f.call()).rejects.toMatchObject({ status: 429 });
    const rows = await usageRepository.listMemberDays(f.run.user.userId, "2026-10-02", "2026-10-02");
    expect(rows[0]?.costUsd["selfhosted/native"]).toBe(1);
    expect(rows[0]?.calls["selfhosted/native"]).toBe(2);
    expect(f.transport.forward).toHaveBeenCalledTimes(2);
  });
  it.each(["cancelled", "closed", "foreign", "expired", "wrong-runtime"])("rejects %s runs before provider dispatch", async variant => {
    const f = await fixture();
    if (variant === "cancelled") f.run.cancelRequestedAt = now.toISOString();
    if (variant === "closed") f.workspace.status = "closing";
    if (variant === "foreign") f.workspace.activeRunId = "another-run";
    if (variant === "expired") f.run.startedAt = "2026-10-01T23:00:00Z";
    if (variant === "wrong-runtime") f.workspace.runtime = "claude";
    await expect(f.call()).rejects.toMatchObject({ status: 403 });
    expect(f.transport.forward).not.toHaveBeenCalled();
  });
  it("revalidates revocation, endpoint and model scope and survives a worker lease change", async () => {
    const f = await fixture();
    await expect(f.call("v1/files")).rejects.toMatchObject({ status: 403 });
    await expect(f.call("v1/responses", { model: "other" })).rejects.toMatchObject({ status: 403 });
    f.workspace.leaseToken = "new-worker";
    await f.call();
    vi.mocked(f.deps.authorize).mockRejectedValueOnce(new Error("Credential revoked"));
    await expect(f.call()).rejects.toThrow("Credential revoked");
    expect(f.transport.forward).toHaveBeenCalledTimes(1);
  });
  it("keeps missing usage uncertain and refuses subsequent paid requests without replay", async () => {
    const f = await fixture();
    vi.mocked(f.transport.forward).mockImplementationOnce(async input => { await input.finish(undefined, false); return Response.json({ ok: true }); });
    await f.call();
    expect(await f.gateway.settle("ws", "run")).toContain("could not be fully confirmed");
    await expect(f.call()).rejects.toMatchObject({ status: 409 });
    expect(f.transport.forward).toHaveBeenCalledTimes(1);
    expect(await usageRepository.listMemberDays(f.run.user.userId, "2026-10-02", "2026-10-02")).toEqual([]);
  });
  it("recovers captured accounting after a database failure without sending another inference", async () => {
    const f = await fixture(); const record = vi.spyOn(f.deps.usage, "record");
    record.mockRejectedValueOnce(new Error("Database unavailable"));
    await expect(f.call()).rejects.toThrow("Database unavailable");
    expect((await workspaceModelCalls.get("ws", "run"))?.usage?.costUsd).toBe(0.5);
    expect(await f.gateway.settle("ws", "run")).toBeUndefined();
    expect(await f.gateway.settle("ws", "run")).toBeUndefined();
    expect(f.transport.forward).toHaveBeenCalledTimes(1);
    expect((await usageRepository.listMemberDays(f.run.user.userId, "2026-10-02", "2026-10-02"))[0]?.calls["selfhosted/native"]).toBe(1);
    record.mockRestore();
  });
  it("rejects tampered and expired credentials", async () => {
    const f = await fixture(); await expect(f.gateway.authorize(f.token + "x")).rejects.toMatchObject({ status: 403 });
    const tokens = createWorkspaceModelTokens(Buffer.alloc(32, 3));
    expect(tokens.verify(f.token, Math.floor(now.getTime() / 1000) + 60)).toBeNull();
    expect(createWorkspaceModelTokens(Buffer.alloc(32, 4)).verify(f.token, Math.floor(now.getTime() / 1000))).toBeNull();
  });
});
