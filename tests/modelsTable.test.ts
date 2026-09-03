import { describe, expect, it } from "vitest";
import type { ModelConfig } from "@/domain/llm/models";
import {
  DEFAULT_MODEL_TABLE_STATE,
  deserializeModelTableState,
  nextSort,
  normalizeModelTableState,
  visibleModelRows,
} from "@/app/models/modelTable";

const model = (
  id: string,
  displayName: string,
  inputPer1M: number,
  pricing: Partial<ModelConfig["pricing"]> = {},
  type: "text" | "image" | "embedding" | "reranker" = "text",
): ModelConfig & { type: "text" | "image" | "embedding" | "reranker" } => ({
  id,
  provider: id.split("/")[0]!,
  family: id.split("/")[1]!,
  maker: "openai",
  displayName,
  pricing: { inputPer1M, outputPer1M: inputPer1M * 2, ...pricing },
  capabilities: {
    tools: false,
    structuredOutput: false,
    imageInput: false,
    reasoning: false,
  },
  contextWindow: 1,
  maxTokens: 1,
  type,
});

const models = [
  model("openai/z", "Zulu", 2, { outputPer1M: 10 }),
  model("anthropic/a", "Alpha", 3, { outputPer1M: 1 }),
  model("openai/i", "Image", 0, { perImage: 0.04 }, "image"),
  model("openrouter/e", "Embedding", 0.02, { outputPer1M: 0 }, "embedding"),
  model("selfhosted/r", "Reranker", 0, { outputPer1M: 0 }, "reranker"),
];

describe("models table", () => {
  it("filters one provider without mutating the catalog", () => {
    expect(visibleModelRows(models, {
      provider: "openai",
      type: null,
      capabilities: [],
      sortKey: "name",
      direction: "asc",
    }).map((item) => item.id)).toEqual(["openai/i", "openai/z"]);
    expect(models.map((item) => item.id)).toEqual([
      "openai/z",
      "anthropic/a",
      "openai/i",
      "openrouter/e",
      "selfhosted/r",
    ]);
  });

  it("sorts by provider, name, and output price", () => {
    expect(visibleModelRows(models, {
      provider: null,
      type: null,
      capabilities: [],
      sortKey: "provider",
      direction: "asc",
    }).map((item) => item.id)).toEqual(["anthropic/a", "openai/i", "openai/z", "openrouter/e", "selfhosted/r"]);
    expect(visibleModelRows(models, {
      provider: null,
      type: null,
      capabilities: [],
      sortKey: "name",
      direction: "desc",
    }).map((item) => item.displayName)).toEqual(["Zulu", "Reranker", "Image", "Embedding", "Alpha"]);
    expect(visibleModelRows(models, {
      provider: null,
      type: null,
      capabilities: [],
      sortKey: "price",
      direction: "asc",
    }).map((item) => item.id)).toEqual(["selfhosted/r", "openrouter/e", "openai/i", "anthropic/a", "openai/z"]);
  });

  it("requires every selected capability alongside the provider filter", () => {
    const capable = models.map((item) => item.id === "openai/z"
      ? { ...item, capabilities: { ...item.capabilities, tools: true, reasoning: true } }
      : item);

    expect(visibleModelRows(capable, {
      provider: "openai",
      type: null,
      capabilities: ["tools", "reasoning"],
      sortKey: "name",
      direction: "asc",
    }).map((item) => item.id)).toEqual(["openai/z"]);
    expect(visibleModelRows(capable, {
      provider: "openai",
      type: null,
      capabilities: ["tools", "imageInput"],
      sortKey: "name",
      direction: "asc",
    })).toEqual([]);
  });

  it("filters model types independently of capabilities", () => {
    expect(visibleModelRows(models, {
      provider: null,
      type: "embedding",
      capabilities: [],
      sortKey: "name",
      direction: "asc",
    }).map((item) => item.id)).toEqual(["openrouter/e"]);
    expect(visibleModelRows(models, {
      provider: null,
      type: "reranker",
      capabilities: [],
      sortKey: "name",
      direction: "asc",
    }).map((item) => item.id)).toEqual(["selfhosted/r"]);
  });

  it("toggles the active key and starts a new key ascending", () => {
    expect(nextSort("provider", "asc", "provider")).toEqual({
      sortKey: "provider",
      direction: "desc",
    });
    expect(nextSort("provider", "desc", "price")).toEqual({
      sortKey: "price",
      direction: "asc",
    });
  });

  it("restores valid browser preferences and drops invalid fields", () => {
    expect(normalizeModelTableState({
      provider: "openrouter",
      type: "embedding",
      capabilities: ["tools", "bogus", "imageInput"],
      sortKey: "price",
      direction: "desc",
    })).toEqual({
      provider: "openrouter",
      type: "embedding",
      capabilities: ["tools", "imageInput"],
      sortKey: "price",
      direction: "desc",
    });
    expect(deserializeModelTableState("not json")).toEqual(DEFAULT_MODEL_TABLE_STATE);
  });
});
