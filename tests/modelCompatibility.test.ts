import { describe, expect, it } from "vitest";
import { agentModelRejectReason } from "@/application/agent/modelCompatibility";
import type { ModelConfig } from "@/domain/llm/models";

const model: ModelConfig = {
  id: "router/jev", provider: "router", family: "jev", maker: "typesafe", displayName: "Jev",
  contextWindow: 32000, maxTokens: 0, pricing: { inputPer1M: 0.042, outputPer1M: 0 },
  capabilities: { tools: true, structuredOutput: false, imageInput: false, reasoning: false, decision: true },
};

describe("Agent model compatibility", () => {
  it("rejects a decisions model even if its metadata claims tool support", () => {
    expect(agentModelRejectReason(model)).toBe("type");
    expect(agentModelRejectReason({ ...model, capabilities: { ...model.capabilities, decision: false } })).toBeNull();
  });
});
