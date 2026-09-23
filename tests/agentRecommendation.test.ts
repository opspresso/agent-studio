import { describe, expect, it, vi } from "vitest";
import { createAgentRecommendationUseCases } from "@/application/llm/agentRecommendation";
import type { DecisionModel } from "@/domain/llm/decision";

const candidates = [
  { name: "writer", displayName: "Writer", description: "Drafts articles" },
  { name: "coder", displayName: "Coder", description: "Changes code" },
];
const quota = { admit: async () => undefined };

describe("Agent recommendation", () => {
  it("sends the user's text and accessible candidates as a closed Choice", async () => {
    const choose = vi.fn<DecisionModel["choose"]>().mockResolvedValue({
      choice: "agent_1", confidence: 0.8, probabilities: { agent_0: 0.1, agent_1: 0.8, none: 0.1 },
    });
    const list = vi.fn().mockResolvedValue(candidates);
    const useCases = createAgentRecommendationUseCases({ decision: { choose }, quota, selectedModel: async () => "router/jev", candidates: list });
    expect(await useCases.recommend("chat", "person@example.test", "Please fix this code")).toEqual({ name: "coder", confidence: 0.8 });
    expect(list).toHaveBeenCalledWith("chat", "person@example.test");
    expect(choose).toHaveBeenCalledTimes(1);
    expect(choose).toHaveBeenCalledWith(expect.objectContaining({
      model: "router/jev", state: "Please fix this code",
      criteria: { agent_0: "Writer: Drafts articles", agent_1: "Coder: Changes code", none: expect.any(String) },
    }));
  });

  it("does not call the provider without a selected model or candidates", async () => {
    const choose = vi.fn<DecisionModel["choose"]>();
    const useCases = createAgentRecommendationUseCases({ decision: { choose }, quota, selectedModel: async () => undefined, candidates: async () => candidates });
    expect(await useCases.recommend("workspace", "person@example.test", "Code this")).toBeNull();
    expect(choose).not.toHaveBeenCalled();
  });

  it("masks recognized PII before sending the request or Agent descriptions to Jev", async () => {
    const choose = vi.fn<DecisionModel["choose"]>().mockResolvedValue({
      choice: "agent_0", confidence: 0.9, probabilities: { agent_0: 0.9, none: 0.1 },
    });
    const useCases = createAgentRecommendationUseCases({
      decision: { choose }, quota, selectedModel: async () => "router/jev",
      candidates: async () => [{ name: "support", displayName: "Contact alice@example.com", description: "Call 010-1234-5678" }],
    });
    expect(await useCases.recommend("chat", "person@example.test", "Email alice@example.com"))
      .toMatchObject({ name: "support" });
    const sent = choose.mock.calls[0]![0];
    expect(`${sent.state} ${Object.values(sent.criteria).join(" ")}`).not.toMatch(/alice@example\.com|010-1234-5678/);
    expect(sent.state).toContain("[[PII:");
  });

  it("returns no suggestion for none and rejects a fabricated Agent key", async () => {
    const choose = vi.fn<DecisionModel["choose"]>().mockResolvedValueOnce({ choice: "none", confidence: 1, probabilities: {} })
      .mockResolvedValueOnce({ choice: "hidden", confidence: 1, probabilities: {} });
    const useCases = createAgentRecommendationUseCases({ decision: { choose }, quota, selectedModel: async () => "router/jev", candidates: async () => candidates });
    expect(await useCases.recommend("chat", "person@example.test", "Anything")).toBeNull();
    await expect(useCases.recommend("chat", "person@example.test", "Anything")).rejects.toThrow("unknown Agent option");
  });

  it("refuses a quota-exhausted request before contacting Jev", async () => {
    const choose = vi.fn<DecisionModel["choose"]>();
    const useCases = createAgentRecommendationUseCases({
      decision: { choose }, quota: { admit: async () => 12 },
      selectedModel: async () => "router/jev", candidates: async () => candidates,
    });
    await expect(useCases.recommend("chat", "person@example.test", "Fix this"))
      .rejects.toMatchObject({ status: 429, retryAfterSeconds: 12 });
    expect(choose).not.toHaveBeenCalled();
  });

  it("keeps every candidate within Jev's 255-option limit", async () => {
    const choose = vi.fn<DecisionModel["choose"]>().mockImplementation(async ({ criteria }) => ({
      choice: "agent_0", confidence: 0.6, probabilities: Object.fromEntries(Object.keys(criteria).map(key => [key, key === "agent_0" ? 1 : 0])),
    }));
    const all = Array.from({ length: 300 }, (_, n) => ({ name: `agent-${n}`, displayName: `Agent ${n}`, description: "Handles requests" }));
    const useCases = createAgentRecommendationUseCases({ decision: { choose }, quota, selectedModel: async () => "router/jev", candidates: async () => all });
    expect(await useCases.recommend("workspace", "person@example.test", "Handle this task")).toEqual({ name: "agent-0", confidence: 0.6 });
    expect(choose).toHaveBeenCalledTimes(6);
    expect(Object.keys(choose.mock.calls[0]![0].criteria)).toHaveLength(65);
  });
});
