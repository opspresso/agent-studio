import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceModelTransport } from "@/infrastructure/workspace/modelTransport";
import { createNativeUsageObserver } from "@/infrastructure/workspace/nativeModelUsage";
import type { NativeModelProtocol, WorkspaceModelTransport } from "@/domain/workspace/modelGateway";
import { activeWorkspaceModelRequests } from "@/lib/workspaceModelMetrics";
import { GET as metrics } from "@/app/api/metrics/route";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const target = { providerName: "selfhosted", baseUrl: "https://provider.example.test/v1", apiKey: "provider-key", auth: "bearer" as const, model: "native" };
const transport = createWorkspaceModelTransport(async () => target);
function input(protocol: NativeModelProtocol): Parameters<WorkspaceModelTransport["forward"]>[0] {
  return { model: "registered/native", protocol, body: { model: "native", stream: true },
    headers: { authorization: "caller-token", cookie: "private", "x-api-key": "caller-token", "anthropic-beta": "test-beta" },
    signal: new AbortController().signal, finish: vi.fn(async () => {}) };
}
function streaming(events: unknown[], crlf = false) {
  const text = events.map(event => "event: message\ndata: " + (event === "[DONE]" ? event : JSON.stringify(event)) + "\n\n").join("").replace(/\n/g, crlf ? "\r\n" : "\n");
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (at >= bytes.length) controller.close(); else controller.enqueue(bytes.slice(at, ++at));
  } }), { headers: { "content-type": "text/event-stream" } });
}

it("captures one duration snapshot across native accounting retries", async () => {
  let now = 0;
  vi.mocked(performance.now).mockImplementation(() => now);
  vi.stubGlobal("fetch", vi.fn(async () => {
    now += 500;
    return Response.json({ usage: { input_tokens: 10, output_tokens: 20 } });
  }));
  const args = input("responses");
  vi.mocked(args.finish).mockImplementationOnce(async () => { now += 9000; throw new Error("accounting unavailable"); });
  await transport.forward(args);
  expect(args.finish).toHaveBeenCalledTimes(2);
  for (const [usage, complete] of vi.mocked(args.finish).mock.calls) {
    expect(usage).toMatchObject({ modelDurationMs: 500, outputTokens: 20 });
    expect(complete).toBe(true);
  }
});
describe("transparent native model transport", () => {
  it("exposes native Gateway load while the provider is pending and releases a JSON response", async () => {
    let respond!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { respond = resolve; });
    let entered!: () => void;
    const called = new Promise<void>(resolve => { entered = resolve; });
    vi.stubGlobal("fetch", vi.fn(() => { entered(); return pending; }));
    const forwarding = transport.forward(input("responses"));
    await called;
    expect(activeWorkspaceModelRequests()).toBe(1);
    expect(await metrics().text()).toContain("agent_studio_active_workspace_model_requests 1");
    expect(await metrics().text()).toContain("agent_studio_active_execution_requests 1");
    respond(Response.json({ usage: { input_tokens: 1, output_tokens: 1 } }));
    await forwarding;
    expect(activeWorkspaceModelRequests()).toBe(0);
    expect(await metrics().text()).toContain("agent_studio_active_workspace_model_requests 0");
    expect(await metrics().text()).toContain("agent_studio_active_execution_requests 0");
  });
  it("keeps streaming requests active until their response body ends", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streaming([
      { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
    ])));
    const args = input("responses");
    const response = await transport.forward(args);
    expect(activeWorkspaceModelRequests()).toBe(1);
    await response.text();
    expect(activeWorkspaceModelRequests()).toBe(0);
    expect(args.finish).toHaveBeenCalledTimes(1);
  });
  it("releases cancelled stream load even when both accounting attempts fail", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streaming([{ type: "response.output_text.delta", delta: "pending" }])));
    const args = input("responses");
    args.finish = vi.fn(async () => { throw new Error("Accounting unavailable"); });
    const response = await transport.forward(args);
    expect(activeWorkspaceModelRequests()).toBe(1);
    await expect(response.body!.cancel()).rejects.toThrow("Accounting unavailable");
    expect(activeWorkspaceModelRequests()).toBe(0);
    expect(args.finish).toHaveBeenCalledTimes(2);
  });
  it.each(["configuration", "fetch", "refusal"])("releases Gateway load after %s failure", async kind => {
    const args = input("responses");
    const adapter = createWorkspaceModelTransport(async () => {
      if (kind === "configuration") throw new Error("Configuration unavailable");
      return target;
    });
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (kind === "fetch") throw new Error("Transport unavailable");
      return new Response("Unavailable", { status: 503 });
    }));
    if (kind === "refusal") expect((await adapter.forward(args)).status).toBe(503);
    else await expect(adapter.forward(args)).rejects.toThrow("Native model");
    expect(activeWorkspaceModelRequests()).toBe(0);
  });
  it.each(["json", "frame", "total"])("bounds %s bytes, cancels upstream and records uncertainty without replay", async kind => {
    const cancel = vi.fn();
    const megabyte = 1024 * 1024;
    const chunk = new TextEncoder().encode(kind === "frame" ? "data: " + "x".repeat(8 * megabyte) : kind === "total" ? ":" + "x".repeat(megabyte - 3) + "\n\n" : "x".repeat(megabyte));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
      pull(output) { output.enqueue(chunk); }, cancel,
    }), { headers: { "content-type": kind === "json" ? "application/json" : "text/event-stream" } })));
    const args = input("responses");
    await expect((async () => {
      const reader = (await transport.forward(args)).body!.getReader();
      for (;;) { const { done } = await reader.read(); if (done) break; }
    })()).rejects.toThrow("Native model");
    expect(cancel).toHaveBeenCalled();
    expect(args.finish).toHaveBeenCalledExactlyOnceWith(undefined, false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["resolver", "header"])("clears admission on a %s failure before any inference", async kind => {
    vi.stubGlobal("fetch", vi.fn());
    const adapter = createWorkspaceModelTransport(async () => {
      if (kind === "resolver") throw new Error("Unavailable");
      return { ...target, apiKey: "invalid\nkey" };
    });
    const args = input("responses");
    await expect(adapter.forward(args)).rejects.toThrow("configuration is unavailable");
    expect(args.finish).toHaveBeenCalledWith(undefined, true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("forwards split UTF-8 Responses SSE with server-only credentials and request usage", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streaming([
      { type: "response.output_text.delta", delta: "확인" },
      { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5,
        input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 2 }, cost: 0.25 } } },
    ], true)));
    const args = input("responses"); const response = await transport.forward(args);
    expect(await response.text()).toContain("확인");
    expect(args.finish).toHaveBeenCalledExactlyOnceWith({ modelDurationMs: 0, inputTokens: 10, outputTokens: 5, cachedTokens: 4, reasoningTokens: 2, costUsd: 0.25 }, true);
    const sent = vi.mocked(fetch).mock.calls[0]!;
    expect(sent[0]).toBe("https://provider.example.test/v1/responses");
    const headers = new Headers(sent[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer provider-key");
    expect(headers.has("cookie")).toBe(false); expect(headers.has("x-api-key")).toBe(false);
    expect(JSON.stringify(sent)).not.toContain("caller-token");
  });
  it("normalizes Anthropic cache input and merges usage snapshots without double counting", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streaming([
      { type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, output_tokens: 0 } } },
      { type: "message_delta", usage: { output_tokens: 5 } }, { type: "message_stop" },
    ])));
    const args = input("messages"); await (await transport.forward(args)).text();
    expect(args.finish).toHaveBeenCalledExactlyOnceWith({ modelDurationMs: 0, inputTokens: 15, outputTokens: 5, cachedTokens: 3, reasoningTokens: 0 }, true);
    const headers = new Headers(vi.mocked(fetch).mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-api-key")).toBe("provider-key"); expect(headers.has("authorization")).toBe(false);
  });
  it("requests Chat Completions usage for hidden helper calls and records one final snapshot", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streaming([{ usage: null, choices: [] },
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2 } } }, "[DONE]"])));
    const args = input("chat/completions"); await (await transport.forward(args)).text();
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body)).stream_options.include_usage).toBe(true);
    expect(args.finish).toHaveBeenCalledExactlyOnceWith({ modelDurationMs: 0, inputTokens: 5, outputTokens: 3, cachedTokens: 2, reasoningTokens: 0 }, true);
  });
  it("records JSON responses and distinguishes an explicit zero from missing usage", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ object: "response", status: "completed", error: null, usage: { input_tokens: 0, output_tokens: 0 } })));
    const args = input("responses"); args.body.stream = false;
    await (await transport.forward(args)).text();
    expect(args.finish).toHaveBeenCalledExactlyOnceWith({ modelDurationMs: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 }, true);
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ output: [] }));
    const missing = input("responses"); await (await transport.forward(missing)).text();
    expect(missing.finish).toHaveBeenCalledWith(undefined, false);
  });
  it("preserves observed partial usage as uncertain when the stream ends without completion", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streaming([{ type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } }])));
    const args = input("messages"); await (await transport.forward(args)).text();
    expect(args.finish).toHaveBeenCalledWith({ inputTokens: 10, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 }, false);
  });
  it("does not replay inference or expose response bodies when transport or accounting fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("echoed-provider-key", { status: 502 })));
    const args = input("responses"); const response = await transport.forward(args);
    expect(await response.text()).not.toContain("echoed-provider-key");
    expect(args.finish).toHaveBeenCalledWith(undefined, false);
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.mocked(fetch).mockResolvedValueOnce(streaming([{ type: "response.completed", response: { usage: { input_tokens: 2, output_tokens: 1 } } }]));
    const failed = input("responses"); vi.mocked(failed.finish).mockRejectedValueOnce(new Error("Accounting failed"));
    expect(await (await transport.forward(failed)).text()).toContain("response.completed");
    expect(failed.finish).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("marks a disconnected stream uncertain and cancels its upstream reader", async () => {
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ cancel }), { headers: { "content-type": "text/event-stream" } })));
    const args = input("responses"); await (await transport.forward(args)).body!.cancel();
    expect(cancel).toHaveBeenCalled(); expect(args.finish).toHaveBeenCalledWith(undefined, false);
  });
  it("does not manufacture usage from invalid counters", () => {
    const observer = createNativeUsageObserver("responses");
    observer.observe({ usage: { input_tokens: -1, output_tokens: "1" } }, true);
    expect(observer.result()).toEqual({ complete: false });
  });
});
