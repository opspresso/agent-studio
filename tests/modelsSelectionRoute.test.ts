import { beforeEach, describe, expect, it, vi } from "vitest";
import { ValidationError } from "@/application/errors";

const { modelSelectionUseCases } = vi.hoisted(() => ({
  modelSelectionUseCases: { select: vi.fn() },
}));

vi.mock("@/lib/session", () => ({
  withAdminAuth:
    (handler: (user: { email: string }, request: Request) => unknown) =>
    (request: Request) =>
      handler({ email: "admin@example.com" }, request),
}));
vi.mock("@/lib/container", () => ({ modelSelectionUseCases }));

const { PUT } = await import("@/app/api/models/selection/route");

const put = (body: unknown) =>
  PUT(
    new Request("https://studio.example.com/api/models/selection", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PUT /api/models/selection", () => {
  it("passes an approved embedding migration to the bound use case", async () => {
    modelSelectionUseCases.select.mockResolvedValue({
      settings: {},
      migration: { indexed: 12, removed: 0, undiscovered: [] },
    });
    const res = await put({
      type: "embedding",
      model: "selfhosted/Qwen/Qwen3-Embedding-4B",
      migrate: true,
    });
    expect(res.status).toBe(200);
    expect(modelSelectionUseCases.select).toHaveBeenCalledWith(
      "embedding",
      "selfhosted/Qwen/Qwen3-Embedding-4B",
      true,
      "admin@example.com",
      undefined,
      undefined,
    );
  });

  it("rejects malformed types before the use case", async () => {
    const res = await put({ type: "text", model: "openai/gpt-5.4" });
    expect(res.status).toBe(400);
    expect(modelSelectionUseCases.select).not.toHaveBeenCalled();
  });

  it("passes a rerank selection to the bound use case", async () => {
    modelSelectionUseCases.select.mockResolvedValue({ settings: {} });
    const res = await put({
      type: "rerank",
      model: "selfhosted/Qwen/Qwen3-Reranker-0.6B",
    });
    expect(res.status).toBe(200);
    expect(modelSelectionUseCases.select).toHaveBeenCalledWith(
      "rerank",
      "selfhosted/Qwen/Qwen3-Reranker-0.6B",
      false,
      "admin@example.com",
      undefined,
      undefined,
    );
  });

  it("passes a rerank score floor to the bound use case", async () => {
    modelSelectionUseCases.select.mockResolvedValue({ settings: {} });
    const res = await put({
      type: "rerank",
      model: "selfhosted/Qwen/Qwen3-Reranker-0.6B",
      rerankerMinScore: 0.05,
    });
    expect(res.status).toBe(200);
    expect(modelSelectionUseCases.select).toHaveBeenCalledWith(
      "rerank",
      "selfhosted/Qwen/Qwen3-Reranker-0.6B",
      false,
      "admin@example.com",
      0.05,
      undefined,
    );
  });

  it("passes an embedding score floor to the bound use case", async () => {
    modelSelectionUseCases.select.mockResolvedValue({ settings: {} });
    const res = await put({ type: "embedding", model: "selfhosted/Qwen/Qwen3-Embedding-4B", catalogMinScore: 0.35 });
    expect(res.status).toBe(200);
    expect(modelSelectionUseCases.select).toHaveBeenCalledWith(
      "embedding", "selfhosted/Qwen/Qwen3-Embedding-4B", false, "admin@example.com", undefined, 0.35,
    );
  });

  it("rejects an embedding score floor outside zero to one", async () => {
    const res = await put({ type: "embedding", model: "selfhosted/Qwen/Qwen3-Embedding-4B", catalogMinScore: -0.1 });
    expect(res.status).toBe(400);
    expect(modelSelectionUseCases.select).not.toHaveBeenCalled();
  });

  it("rejects a rerank score floor outside zero to one", async () => {
    const res = await put({
      type: "rerank",
      model: "selfhosted/Qwen/Qwen3-Reranker-0.6B",
      rerankerMinScore: 1.1,
    });
    expect(res.status).toBe(400);
    expect(modelSelectionUseCases.select).not.toHaveBeenCalled();
  });

  it("maps a model type mismatch to 400", async () => {
    modelSelectionUseCases.select.mockRejectedValue(
      new ValidationError('Model "openai/gpt-5.4" is not an embedding model'),
    );
    const res = await put({ type: "embedding", model: "openai/gpt-5.4", migrate: true });
    expect(res.status).toBe(400);
  });
});
