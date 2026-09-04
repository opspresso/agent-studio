import { describe, expect, it } from "vitest";
import {
  selfHostedModelFromInput,
  upsertSelfHostedModelInput,
  type SelfHostedModelInput,
} from "@/domain/llm/selfHostedModels";

const input = (family: string, type: SelfHostedModelInput["type"]): SelfHostedModelInput => ({
  family,
  displayName: family,
  type,
  contextWindow: 32768,
  maxTokens: type === "embedding" || type === "rerank" ? 0 : 1024,
  capabilities: {
    tools: type === "text",
    structuredOutput: type === "text",
    imageInput: false,
    reasoning: false,
  },
});

describe("self-hosted model input", () => {
  it("replaces an existing family instead of creating a duplicate declaration", () => {
    const original = selfHostedModelFromInput(input("Qwen/model", "embedding"));
    const edited = { ...input("Qwen/model", "rerank"), displayName: "Qwen Reranker" };

    expect(upsertSelfHostedModelInput([original], edited)).toEqual([edited]);
  });

  it("appends a family that has not been declared", () => {
    const original = input("Qwen/embedding", "embedding");
    const added = input("Qwen/reranker", "rerank");

    expect(upsertSelfHostedModelInput([selfHostedModelFromInput(original)], added)).toEqual([
      { ...original, maker: "Qwen" },
      added,
    ]);
  });
});
