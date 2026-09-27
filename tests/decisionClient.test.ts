import { afterEach, describe, expect, it, vi } from "vitest";
import { createDecisionClient } from "@/infrastructure/llm/decisionClient";
import type { ResolvedTarget } from "@/infrastructure/llm/providers";

const target: ResolvedTarget = {
  providerName: "openrouter", baseUrl: "https://router.test/api/v1", apiKey: "secret", auth: "bearer", model: "~typesafe/jev-latest",
};
const input = { model: "router/~typesafe/jev-latest", state: "Fix code", instructions: "Pick an Agent", criteria: { agent_0: "Coder", none: "No match" } };
afterEach(() => vi.unstubAllGlobals());

describe("decision provider adapter", () => {
  it.each([
    { input_tokens: 20, output_tokens: 3, cost: 0.001 },
    { prompt_tokens: 20, completion_tokens: 3, cost: 0.001 },
  ])("preserves native decision billing for %j", async (usage) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      answers: { selection: { type: "choice", choice: "agent_0", confidence: 0.9, probabilities: { agent_0: 0.9, none: 0.1 } } }, usage,
    })));
    expect((await createDecisionClient(async () => target).choose(input)).usage)
      .toEqual({ model: input.model, inputTokens: 20, outputTokens: 3, costUsd: 0.001 });
  });
  it("calls the OpenRouter Decisions endpoint with a native Choice request", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ answers: { selection: { type: "choice", choice: "agent_0", confidence: 0.9, probabilities: { agent_0: 0.9, none: 0.1 } } } }));
    vi.stubGlobal("fetch", fetch);
    const client = createDecisionClient(async () => ({ ...target, baseUrl: "https://router.test/api/v1/" }));
    expect(await client.choose(input)).toMatchObject({ choice: "agent_0", confidence: 0.9 });
    const [url, options] = fetch.mock.calls[0]!;
    expect(url).toBe("https://router.test/api/alpha/decisions");
    expect(options.headers.Authorization).toBe("Bearer secret");
    expect(JSON.parse(options.body)).toEqual({ model: "~typesafe/jev-latest", state: "Fix code", questions: { selection: { type: "choice", instructions: "Pick an Agent", criteria: input.criteria } } });
  });

  it("uses a configured System One endpoint and refuses malformed output", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ answers: { selection: { type: "choice", choice: "unknown", confidence: 1, probabilities: {} } } }));
    vi.stubGlobal("fetch", fetch);
    const client = createDecisionClient(async () => ({ ...target, providerName: "selfhosted", baseUrl: "https://inside.test/v1/", model: "jev-latest" }));
    await expect(client.choose(input)).rejects.toThrow("invalid Choice answer");
    expect(fetch.mock.calls[0]![0]).toBe("https://inside.test/v1/systemone");
  });
});
