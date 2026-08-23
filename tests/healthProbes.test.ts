import { afterEach, describe, expect, it, vi } from "vitest";

const { behavior } = vi.hoisted(() => ({ behavior: { mode: "ok" as "ok" | "boom" } }));

// The probe is one statement through the client; the pool itself is never
// opened here (tests/setup.ts stubs it), so only `sql` decides the answer.
vi.mock("@/infrastructure/db/client", () => ({
  sql: async () => {
    if (behavior.mode === "boom") {
      throw new Error("throttled");
    }
    return [];
  },
}));

// The channel config is injected, so the probe reaches no settings module.
const loadChannelConfig = async () => ({ baseUrl: "http://llm.test/v1", apiKey: "k" });

const { dbReachable, llmReachable } = await import("@/infrastructure/health/probes");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dbReachable", () => {
  it("resolves when the datastore responds", async () => {
    behavior.mode = "ok";
    await expect(dbReachable()).resolves.toBeUndefined();
  });

  it("rejects when the datastore errors", async () => {
    behavior.mode = "boom";
    await expect(dbReachable()).rejects.toThrow("throttled");
  });
});

describe("llmReachable", () => {
  it("resolves on any HTTP response and probes /models without a completion", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(llmReachable(loadChannelConfig)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith("http://llm.test/v1/models", expect.anything());
  });

  it("rejects on a network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await expect(llmReachable(loadChannelConfig)).rejects.toThrow("ECONNREFUSED");
  });
});
