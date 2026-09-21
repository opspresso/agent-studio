import { describe, expect, it } from "vitest";
import type { ModelConfig, ModelType } from "@/domain/llm/models";
import {
  DEFAULT_MODEL_TABLE_STATE,
  deserializeModelTableState,
  nextSort,
  normalizeModelTableState,
  selectableRetrievalModels,
  visibleModelRows,
  sortModelRows,
  modelOutputTypes,
  DEFAULT_MODEL_BROWSER_STATE,
  deserializeModelBrowserState,
  deserializeModelProvider,
} from "@/app/models/modelTable";

const model = (
  id: string,
  displayName: string,
  inputPer1M: number,
  pricing: Partial<ModelConfig["pricing"]> = {},
  type: ModelType = "text",
): ModelConfig & { type: ModelType } => ({
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
  model("selfhosted/r", "Rerank", 0, { outputPer1M: 0, perSearch: 0.001 }, "rerank"),
  model("openrouter/t", "Transcription", 0, { outputPer1M: 0, perAudioMinute: 0.006 }, "transcription"),
];

describe("models table", () => {
  it("restores browser filters and ordering while rejecting malformed saved preferences", () => {
    expect(deserializeModelBrowserState(JSON.stringify({ query: "Jev", type: "decisions", selectedOnly: true, capabilities: ["tools", "invalid"], sortKey: "price", direction: "desc", page: 3 })))
      .toMatchObject({ query: "Jev", type: "decisions", selectedOnly: true, capabilities: ["tools"], sortKey: "price", direction: "desc", page: 3 });
    expect(deserializeModelBrowserState("invalid JSON")).toEqual(DEFAULT_MODEL_BROWSER_STATE);
    expect(deserializeModelBrowserState(JSON.stringify({ page: -1, selectedOnly: "true", sortKey: "invalid", query: 4 })))
      .toMatchObject({ page: 1, selectedOnly: false, sortKey: "name", query: "" });
    expect(deserializeModelProvider('"company-openrouter"')).toBe("company-openrouter");
    expect(deserializeModelProvider("{}")).toBeNull();
  });
  it("retains overlapping output types for both badges and filtering", () => {
    expect(modelOutputTypes({ type: "image", outputModalities: ["text", "image"] })).toEqual(["image", "text"]);
    expect(modelOutputTypes({ type: "embedding", outputModalities: ["embeddings"] })).toEqual(["embedding"]);
    expect(modelOutputTypes({ outputModalities: ["speech"] })).toEqual(["speech"]);
  });
  it("sorts zero prices as known values and keeps missing prices last in either direction", () => {
    const rows = [
      { displayName: "Unknown" },
      { displayName: "Paid", type: "text" as const, pricing: { inputPer1M: 1, outputPer1M: 2 } },
      { displayName: "Free", type: "text" as const, pricing: { inputPer1M: 0, outputPer1M: 0 } },
      { displayName: "Jev", type: "decisions" as const, pricing: { inputPer1M: 0.042, outputPer1M: 0 } },
    ];
    expect(sortModelRows(rows, "price", "asc").map(model => model.displayName)).toEqual(["Free", "Jev", "Paid", "Unknown"]);
    expect(sortModelRows(rows, "price", "desc").map(model => model.displayName)).toEqual(["Paid", "Jev", "Free", "Unknown"]);
    expect(rows[0]?.displayName).toBe("Unknown");
  });
  it("offers visible retrieval models independently of LLM provider routes", () => {
    const rows = models.map((item) => ({ ...item, selectionHidden: item.id === "openrouter/e" }));

    expect(selectableRetrievalModels(rows, "embedding")).toEqual([]);
    expect(selectableRetrievalModels(rows, "rerank").map((item) => item.id)).toEqual([
      "selfhosted/r",
    ]);
  });

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
      "openrouter/t",
    ]);
  });

  it("sorts by provider, name, and output price", () => {
    expect(visibleModelRows(models, {
      provider: null,
      type: null,
      capabilities: [],
      sortKey: "provider",
      direction: "asc",
    }).map((item) => item.id)).toEqual(["anthropic/a", "openai/i", "openai/z", "openrouter/e", "openrouter/t", "selfhosted/r"]);
    expect(visibleModelRows(models, {
      provider: null,
      type: null,
      capabilities: [],
      sortKey: "name",
      direction: "desc",
    }).map((item) => item.displayName)).toEqual(["Zulu", "Transcription", "Rerank", "Image", "Embedding", "Alpha"]);
    expect(visibleModelRows(models, {
      provider: null,
      type: null,
      capabilities: [],
      sortKey: "price",
      direction: "asc",
    }).map((item) => item.id)).toEqual(["selfhosted/r", "openrouter/t", "openrouter/e", "openai/i", "anthropic/a", "openai/z"]);
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
      type: "rerank",
      capabilities: [],
      sortKey: "name",
      direction: "asc",
    }).map((item) => item.id)).toEqual(["selfhosted/r"]);
    expect(visibleModelRows(models, {
      provider: null,
      type: "transcription",
      capabilities: [],
      sortKey: "name",
      direction: "asc",
    }).map((item) => item.id)).toEqual(["openrouter/t"]);
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
