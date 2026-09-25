import { afterEach, describe, expect, it, vi } from "vitest";
import { listModels, testAgentSlack } from "@/app/agents/lib/api";

afterEach(() => vi.unstubAllGlobals());

describe("Playground model list", () => {
  it("reports a registry failure instead of treating it as an empty registry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "Model registry unavailable" }), { status: 503 }),
    ));

    await expect(listModels()).rejects.toThrow("Model registry unavailable");
  });
});

describe("Slack connection test", () => {
  it("does not treat an expired session as a connection result", async () => {
    const replace = vi.fn();
    vi.stubGlobal("window", { location: {
      origin: "https://studio.example.com", pathname: "/agents/sample/integrations",
      search: "", hash: "", replace,
    } });
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    ));

    await expect(testAgentSlack("sample")).rejects.toThrow("Authentication required");
    expect(replace).toHaveBeenCalledOnce();
  });
});
