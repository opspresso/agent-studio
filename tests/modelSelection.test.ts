import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createModelSelectionUseCases,
  type ModelSelectionDeps,
} from "@/application/llm/modelSelection";
import { loadSelfHostedModels } from "@/domain/llm/models";
import type { AppSettings } from "@/domain/settings/types";

const EMBEDDING = "selfhosted/Qwen/Qwen3-Embedding-4B";
const RERANKER = "selfhosted/Qwen/Qwen3-Reranker-0.6B";

function installModels(): void {
  loadSelfHostedModels([
    {
      id: EMBEDDING,
      provider: "selfhosted",
      family: "Qwen/Qwen3-Embedding-4B",
      maker: "qwen",
      displayName: "Qwen3 Embedding 4B",
      pricing: { inputPer1M: 0, outputPer1M: 0 },
      capabilities: {
        tools: false,
        structuredOutput: false,
        imageInput: false,
        reasoning: false,
        embedding: true,
      },
      contextWindow: 32768,
      maxTokens: 0,
    },
    {
      id: RERANKER,
      provider: "selfhosted",
      family: "Qwen/Qwen3-Reranker-0.6B",
      maker: "qwen",
      displayName: "Qwen3 Reranker 0.6B",
      pricing: { inputPer1M: 0, outputPer1M: 0 },
      capabilities: {
        tools: false,
        structuredOutput: false,
        imageInput: false,
        reasoning: false,
        rerank: true,
      },
      contextWindow: 32768,
      maxTokens: 0,
    },
  ]);
}

function deps(initial: AppSettings | null = null): {
  value: () => AppSettings | null;
  deps: ModelSelectionDeps;
  update: ReturnType<typeof vi.fn>;
  reindex: ReturnType<typeof vi.fn>;
  invalidate: ReturnType<typeof vi.fn>;
} {
  let stored = initial;
  const update = vi.fn(async (patch: Record<string, string>) => {
    stored = {
      ...(stored ?? { updatedAt: "" }),
      ...Object.fromEntries(
        Object.entries(patch).filter(([, value]) => value !== ""),
      ),
      updatedAt: "2026-01-02T00:00:00Z",
    };
    for (const [key, value] of Object.entries(patch)) {
      if (value === "" && stored) delete stored[key as keyof AppSettings];
    }
    return { fields: {}, llmProviders: { source: "env" as const, items: [] } } as never;
  });
  const reindex = vi.fn(async () => ({ indexed: 12, removed: 0, undiscovered: [] }));
  const invalidate = vi.fn();
  const testReranker = vi.fn(async () => {});
  const lock = {
    acquire: vi.fn(async () => "lease-1" as string | null),
    release: vi.fn(async () => {}),
  };
  return {
    value: () => stored,
    update,
    reindex,
    invalidate,
    deps: {
      repository: {
        async get() {
          return stored;
        },
        async put(settings) {
          stored = settings;
        },
      },
      lock,
      settings: { getView: vi.fn() as never, update: update as never },
      current: async () => undefined,
      available: () => true,
      hidden: async () => undefined,
      testReranker,
      invalidate,
      reindex,
    },
  };
}

afterEach(() => {
  loadSelfHostedModels([]);
});

describe("modelSelectionUseCases", () => {
  it("requires explicit migration approval for an embedding change", async () => {
    installModels();
    const setup = deps();
    await expect(
      createModelSelectionUseCases(setup.deps).select("embedding", EMBEDDING, false, "admin@example.com"),
    ).rejects.toThrow("requires migration approval");
    expect(setup.update).not.toHaveBeenCalled();
  });

  it("selects an embedding model and rebuilds the catalog", async () => {
    installModels();
    const setup = deps();
    const result = await createModelSelectionUseCases(setup.deps).select(
      "embedding",
      EMBEDDING,
      true,
      "admin@example.com",
    );
    expect(setup.value()?.embeddingModel).toBe(EMBEDDING);
    expect(setup.invalidate).toHaveBeenCalledOnce();
    expect(setup.reindex).toHaveBeenCalledOnce();
    expect(setup.deps.lock.release).toHaveBeenCalledWith("lease-1");
    expect(result.migration?.indexed).toBe(12);
  });

  it("refuses an embedding migration while another instance holds the lease", async () => {
    installModels();
    const setup = deps();
    vi.mocked(setup.deps.lock.acquire).mockResolvedValue(null);
    await expect(
      createModelSelectionUseCases(setup.deps).select(
        "embedding",
        EMBEDDING,
        true,
        "admin@example.com",
      ),
    ).rejects.toThrow("already running");
    expect(setup.update).not.toHaveBeenCalled();
    expect(setup.reindex).not.toHaveBeenCalled();
  });

  it("releases the lease when reading the previous selection fails", async () => {
    installModels();
    const setup = deps();
    vi.spyOn(setup.deps.repository, "get").mockRejectedValue(new Error("settings unavailable"));
    await expect(
      createModelSelectionUseCases(setup.deps).select(
        "embedding",
        EMBEDDING,
        true,
        "admin@example.com",
      ),
    ).rejects.toThrow("settings unavailable");
    expect(setup.deps.lock.release).toHaveBeenCalledWith("lease-1");
  });

  it("restores the previous selection and index when migration fails", async () => {
    installModels();
    const setup = deps({ embeddingModel: "legacy-model", updatedAt: "2026-01-01T00:00:00Z" });
    setup.reindex
      .mockRejectedValueOnce(new Error("new model failed"))
      .mockResolvedValueOnce({ indexed: 12, removed: 0, undiscovered: [] });
    await expect(
      createModelSelectionUseCases(setup.deps).select(
        "embedding",
        EMBEDDING,
        true,
        "admin@example.com",
      ),
    ).rejects.toThrow("new model failed");
    expect(setup.value()?.embeddingModel).toBe("legacy-model");
    expect(setup.reindex).toHaveBeenCalledTimes(2);
    expect(setup.invalidate).toHaveBeenCalledTimes(2);
  });

  it("changes a rerank model without rebuilding vectors and rejects the wrong type", async () => {
    installModels();
    const setup = deps();
    await createModelSelectionUseCases(setup.deps).select(
      "rerank",
      RERANKER,
      false,
      "admin@example.com",
    );
    expect(setup.value()?.rerankerModel).toBe(RERANKER);
    expect(setup.deps.testReranker).toHaveBeenCalledWith(RERANKER);
    expect(setup.reindex).not.toHaveBeenCalled();
    await expect(
      createModelSelectionUseCases(setup.deps).select(
        "embedding",
        RERANKER,
        true,
        "admin@example.com",
      ),
    ).rejects.toThrow("is not an embedding model");
  });
});
