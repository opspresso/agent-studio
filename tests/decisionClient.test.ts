import { afterEach, describe, expect, it, vi } from "vitest";
import { createDecisionClient } from "@/infrastructure/llm/decisionClient";
import type { ResolvedTarget } from "@/infrastructure/llm/providers";

const target: ResolvedTarget = {
  providerName: "openrouter", baseUrl: "https://router.test/api/v1", apiKey: "secret", auth: "bearer", model: "~typesafe/jev-latest",
};
const input = { model: "router/~typesafe/jev-latest", state: "Fix code", instructions: "Pick an Agent", criteria: { agent_0: "Coder", none: "No match" } };
afterEach(() => vi.unstubAllGlobals());

describe("decision provider adapter", () => {
  it("calls the OpenRouter Decisions endpoint with a native Choice request", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ answers: { agent: { type: "choice", choice: "agent_0", confidence: 0.9, probabilities: { agent_0: 0.9, none: 0.1 } } } }));
    vi.stubGlobal("fetch", fetch);
    const client = createDecisionClient(async () => target);
    expect(await client.choose(input)).toMatchObject({ choice: "agent_0", confidence: 0.9 });
    const [url, options] = fetch.mock.calls[0]!;
    expect(url).toBe("https://router.test/api/alpha/decisions");
    expect(options.headers.Authorization).toBe("Bearer secret");
    expect(JSON.parse(options.body)).toEqual({ model: "~typesafe/jev-latest", state: "Fix code", questions: { agent: { type: "choice", instructions: "Pick an Agent", criteria: input.criteria } } });
  });

  it("uses a configured System One endpoint and refuses malformed output", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ answers: { agent: { type: "choice", choice: "unknown", confidence: 1, probabilities: {} } } }));
    vi.stubGlobal("fetch", fetch);
    const client = createDecisionClient(async () => ({ ...target, providerName: "selfhosted", baseUrl: "https://inside.test/v1", model: "jev-latest" }));
    await expect(client.choose(input)).rejects.toThrow("invalid Choice answer");
    expect(fetch.mock.calls[0]![0]).toBe("https://inside.test/v1/systemone");
  });
});
