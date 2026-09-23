import { afterEach, describe, expect, it, vi } from "vitest";
import { listModels } from "@/app/agents/lib/api";

afterEach(() => vi.unstubAllGlobals());

describe("Playground model list", () => {
  it("reports a registry failure instead of treating it as an empty registry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "Model registry unavailable" }), { status: 503 }),
    ));

    await expect(listModels()).rejects.toThrow("Model registry unavailable");
  });
});
