import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { server } = vi.hoisted(() => ({
  server: { handle: undefined as ((request: unknown, response: unknown) => void) | undefined },
}));
vi.mock("node:http", () => ({
  createServer: (handle: typeof server.handle) => {
    server.handle = handle;
    return { listen: vi.fn() };
  },
}));

beforeAll(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-21T00:00:00.000Z"));
  vi.stubEnv("MOCK_LLM_CHUNKS", "0");
  vi.stubEnv("MOCK_LLM_DELAY_MS", "0");
  await import("../scripts/mock-llm");
});
afterAll(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function send(body: string, url = "/v1/chat/completions", method = "POST") {
  const events = new Map<string, (chunk?: string) => unknown>();
  const request = { url, method, on: (event: string, callback: (chunk?: string) => unknown) => events.set(event, callback) };
  const response = { writeHead: vi.fn().mockReturnThis(), end: vi.fn().mockReturnThis() };
  server.handle!(request, response);
  events.get("data")?.(body);
  await events.get("end")?.();
  return response;
}

describe("local mock LLM request boundary", () => {
  it("advertises a tool-capable model through the real provider discovery adapter", async () => {
    const { createProviderModelDiscovery } = await import("@/infrastructure/llm/providerModelDiscovery");
    const fetchModelList = vi.fn<typeof fetch>(async (input) => {
      const response = await send("", new URL(String(input)).pathname, "GET");
      return new Response(response.end.mock.calls[0]?.[0], {
        status: response.writeHead.mock.calls[0]?.[0], headers: { "content-type": "application/json" },
      });
    });
    const models = await createProviderModelDiscovery(fetchModelList).list({
      name: "local", kind: "selfhosted", baseUrl: "http://localhost:8002/v1", apiKey: "test",
      auth: "bearer", keepModelPrefix: false,
    });
    expect(models).toEqual([expect.objectContaining({
      wireId: "mock-text", type: "text", contextWindow: 128000, maxTokens: 4000,
      capabilities: { tools: true, structuredOutput: false, imageInput: false, reasoning: false },
    })]);
    expect(fetchModelList).toHaveBeenCalledOnce();
  });

  it("still answers a valid completion request", async () => {
    const response = await send('{"messages":[{"role":"user","content":"hello"}]}');
    expect(response.writeHead).toHaveBeenCalledWith(200, { "Content-Type": "application/json" });
    expect(JSON.parse(response.end.mock.calls[0]![0]).choices[0].message.content).toBe("mock answer to: hello");
  });
  it.each(["null", "[]", "{}", '{"messages":null}', '{"messages":[null]}', '{"messages":[4]}', "{bad"])(
    "answers 400 without crashing on %s", async (body) => {
      const response = await send(body);
      expect(response.writeHead).toHaveBeenCalledWith(400);
      expect(response.end).toHaveBeenCalledOnce();
    },
  );
});
