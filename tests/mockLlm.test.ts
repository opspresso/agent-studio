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
  vi.stubEnv("MOCK_LLM_CHUNKS", "0");
  vi.stubEnv("MOCK_LLM_DELAY_MS", "0");
  await import("../scripts/mock-llm");
});
afterAll(() => vi.unstubAllEnvs());

async function send(body: string) {
  const events = new Map<string, (chunk?: string) => unknown>();
  const request = { url: "/v1/chat/completions", on: (event: string, callback: (chunk?: string) => unknown) => events.set(event, callback) };
  const response = { writeHead: vi.fn().mockReturnThis(), end: vi.fn().mockReturnThis() };
  server.handle!(request, response);
  events.get("data")!(body);
  await events.get("end")!();
  return response;
}

describe("local mock LLM request boundary", () => {
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
