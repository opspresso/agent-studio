import { afterEach, describe, expect, it, vi } from "vitest";

const { behavior, fakeClient } = vi.hoisted(() => {
  const behavior = { mode: "ok" as "ok" | "boom" };
  const fakeClient = {
    async send() {
      if (behavior.mode === "boom") {
        throw new Error("throttled");
      }
      return { Item: undefined };
    },
  };
  return { behavior, fakeClient };
});

vi.mock("@/infrastructure/db/client", () => ({
  getDocumentClient: () => fakeClient,
  getTableName: () => "test-table",
}));

vi.mock("@/lib/runtime-settings", () => ({
  getLlmChannelConfig: async () => ({ baseUrl: "http://llm.test/v1", apiKey: "k" }),
}));

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
    await expect(llmReachable()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith("http://llm.test/v1/models", expect.anything());
  });

  it("rejects on a network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await expect(llmReachable()).rejects.toThrow("ECONNREFUSED");
  });
});
