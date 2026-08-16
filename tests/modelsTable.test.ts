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
): ModelConfig => ({
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
});

const models = [
  model("openai/z", "Zulu", 2),
  model("anthropic/a", "Alpha", 3),
  model("openai/i", "Image", 0, { perImage: 0.04 }),
];

describe("models table", () => {
  it("filters one provider without mutating the catalog", () => {
    expect(visibleModelRows(models, {
      provider: "openai",
      capabilities: [],
      sortKey: "name",
      direction: "asc",
    }).map((item) => item.id)).toEqual(["openai/i", "openai/z"]);
    expect(models.map((item) => item.id)).toEqual(["openai/z", "anthropic/a", "openai/i"]);
  });

  it("sorts by provider, name, and the first displayed price", () => {
    expect(visibleModelRows(models, {
      provider: null,
      capabilities: [],
      sortKey: "provider",
      direction: "asc",
    }).map((item) => item.id)).toEqual(["anthropic/a", "openai/i", "openai/z"]);
    expect(visibleModelRows(models, {
      provider: null,
      capabilities: [],
      sortKey: "name",
      direction: "desc",
    }).map((item) => item.displayName)).toEqual(["Zulu", "Image", "Alpha"]);
    expect(visibleModelRows(models, {
      provider: null,
      capabilities: [],
      sortKey: "price",
      direction: "asc",
    }).map((item) => item.id)).toEqual(["openai/i", "openai/z", "anthropic/a"]);
  });

  it("requires every selected capability alongside the provider filter", () => {
    const capable = models.map((item) => item.id === "openai/z"
      ? { ...item, capabilities: { ...item.capabilities, tools: true, reasoning: true } }
      : item);

    expect(visibleModelRows(capable, {
      provider: "openai",
      capabilities: ["tools", "reasoning"],
      sortKey: "name",
      direction: "asc",
    }).map((item) => item.id)).toEqual(["openai/z"]);
    expect(visibleModelRows(capable, {
      provider: "openai",
      capabilities: ["tools", "imageInput"],
      sortKey: "name",
      direction: "asc",
    })).toEqual([]);
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
      capabilities: ["tools", "bogus", "imageInput"],
      sortKey: "price",
      direction: "desc",
    })).toEqual({
      provider: "openrouter",
      capabilities: ["tools", "imageInput"],
      sortKey: "price",
      direction: "desc",
    });
    expect(deserializeModelTableState("not json")).toEqual(DEFAULT_MODEL_TABLE_STATE);
  });
});
