import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_CATALOG_BODY_BYTES } from "@/app/api/_lib/body";

/**
 * The offline catalog path, through its route: admin-only on every verb, a
 * document that is not a catalog refused before it is stored, and a stored
 * one refreshed into the registry before the request is answered. The use
 * case is real over an in-memory repository; only the refresher is a spy,
 * since installing would change the registry every other test reads.
 */
const { gate, repo, refresh } = vi.hoisted(() => {
  let record: { document: unknown; uploadedBy: string; uploadedAt: string } | null = null;
  return {
    gate: { admin: true },
    repo: {
      get: async () => record,
      put: async (next: typeof record) => {
        record = next;
      },
      delete: async () => {
        record = null;
      },
      reset() {
        record = null;
      },
    },
    refresh: vi.fn(async () => true),
  };
});

vi.mock("@/lib/session", () => ({
  withAdminAuth:
    (handler: (user: unknown, ...args: unknown[]) => Promise<Response>) =>
    (...args: unknown[]) =>
      gate.admin
        ? handler({ id: "u1", email: "admin@example.com", name: "A", image: null }, ...args)
        : Promise.resolve(
            Response.json({ error: "Only admins can modify this resource" }, { status: 403 }),
          ),
}));
vi.mock("@/lib/container", async () => {
  const { createModelCatalogDocumentUseCases } = await import(
    "@/application/llm/modelCatalogDocument"
  );
  return {
    modelCatalogDocumentUseCases: createModelCatalogDocumentUseCases(
      repo,
      refresh,
      () => new Date("2026-08-23T10:00:00.000Z"),
    ),
  };
});

const { GET, PUT, DELETE } = await import("@/app/api/models/catalog/document/route");

const URL = "https://studio.example.com/api/models/catalog/document";
const put = (body: string, headers: Record<string, string> = {}) =>
  PUT(new Request(URL, { method: "PUT", body, headers }));

const TEXT = { tools: true, structuredOutput: true, imageInput: true, reasoning: true };
const catalog = {
  version: 1,
  updatedAt: "2026-08-01T00:00:00.000Z",
  makers: { openai: "OpenAI" },
  models: [
    {
      id: "openai/up",
      provider: "openai",
      family: "up",
      maker: "openai",
      displayName: "up",
      pricing: { inputPer1M: 1, outputPer1M: 2 },
      capabilities: TEXT,
      contextWindow: 1000,
      maxTokens: 100,
    },
    // Refused by the loader and named, not a reason to refuse the upload.
    { id: "acme/zed", provider: "acme", family: "zed", maker: "acme" },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  gate.admin = true;
  repo.reset();
});

describe("/api/models/catalog/document", () => {
  it("is the admin's on every verb", async () => {
    gate.admin = false;
    expect((await GET()).status).toBe(403);
    expect((await put(JSON.stringify(catalog))).status).toBe(403);
    expect((await DELETE()).status).toBe(403);
    expect(await repo.get()).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("reports nothing stored as a state, not an error", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stored: false });
  });

  it("refuses a body that is not JSON, or not a catalog, before storing anything", async () => {
    expect((await put("{not json")).status).toBe(400);

    const res = await put(JSON.stringify({ version: 2, models: [] }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/not a usable model catalog: .*version 2/);

    expect(await repo.get()).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refuses a body past the catalog ceiling from its declared length alone", async () => {
    const res = await put("{}", { "content-length": String(MAX_CATALOG_BODY_BYTES + 1) });
    expect(res.status).toBe(413);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("stores a usable catalog with the caller's address, refreshes, and answers what it makes of it", async () => {
    const res = await put(JSON.stringify(catalog));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      stored: true,
      uploadedBy: "admin@example.com",
      uploadedAt: "2026-08-23T10:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      modelCount: 1,
      skipped: ['acme/zed — provider "acme" is not a channel this app has'],
      refreshed: true,
    });
    expect(await repo.get()).toEqual({
      document: catalog,
      uploadedBy: "admin@example.com",
      uploadedAt: "2026-08-23T10:00:00.000Z",
    });
    expect(refresh).toHaveBeenCalledTimes(1);

    // The same picture on a later read, minus the refresh outcome.
    const { refreshed: _, ...status } = (await (await put(JSON.stringify(catalog))).json()) as {
      refreshed: boolean;
    };
    expect(await (await GET()).json()).toEqual(status);
  });

  it("removes the document and refreshes, so the registry can follow another source", async () => {
    await put(JSON.stringify(catalog));
    refresh.mockClear();

    const res = await DELETE();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stored: false, refreshed: true });
    expect(await repo.get()).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
