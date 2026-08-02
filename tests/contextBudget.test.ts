import { describe, expect, it } from "vitest";
import {
  createRunContextBudget,
  estimateContextTokens,
  IMAGE_PART_TOKENS,
} from "@/application/llm/contextBudget";
import { runAgent, type AgentDeps, type RunAgentInput } from "@/application/llm/engine";
import type { EngineChunk } from "@/domain/llm/types";
import { contentChunk, FakeChannel, toolCallChunk, usageChunk } from "./fakeChannel";

async function collect(gen: AsyncGenerator<EngineChunk>): Promise<EngineChunk[]> {
  const chunks: EngineChunk[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

/**
 * 200k-token window, so `maxTokens: 190_000` leaves a small, predictable
 * budget (200_000 − 190_000 − headroom) without megabyte test strings.
 */
const SMALL_WINDOW_MODEL = "anthropic/claude-haiku-4.5";
const SMALL_BUDGET_PARAMS = { maxTokens: 190_000, piiFiltering: false };
/** 1M-token window: every test payload fits with room to spare. */
const HUGE_WINDOW_MODEL = "google/gemini-2.5-flash";

describe("estimateContextTokens", () => {
  it("charges ASCII at 3 chars per token, rounding up", () => {
    expect(estimateContextTokens("abc")).toBe(1);
    expect(estimateContextTokens("abcd")).toBe(2);
  });

  it("charges non-ASCII at 1.5 tokens per char, rounding up", () => {
    // Above the ~0.7–1.5 modern tokenizers charge for Hangul, below the legacy
    // worst case that priced legitimate Korean input over the whole budget.
    expect(estimateContextTokens("가나다")).toBe(5);
    expect(estimateContextTokens("가나")).toBe(3);
  });

  it("charges mixed text per class", () => {
    // "ab" → 1 token, "가" → 2 (1.5 rounded up).
    expect(estimateContextTokens("ab가")).toBe(3);
  });
});

describe("createRunContextBudget", () => {
  it("returns undefined for a model the registry does not know", () => {
    expect(createRunContextBudget("custom/unknown", undefined, undefined)).toBeUndefined();
  });

  it("derives the window from the smaller of primary and fallback", () => {
    const withFallback = createRunContextBudget(HUGE_WINDOW_MODEL, SMALL_WINDOW_MODEL, 190_000);
    const primaryOnly = createRunContextBudget(SMALL_WINDOW_MODEL, undefined, 190_000);
    expect(withFallback?.remaining()).toBe(primaryOnly?.remaining());
  });

  it("ignores an unregistered fallback rather than guessing a window", () => {
    const budget = createRunContextBudget(SMALL_WINDOW_MODEL, "custom/unknown", 190_000);
    expect(budget?.remaining()).toBe(
      createRunContextBudget(SMALL_WINDOW_MODEL, undefined, 190_000)?.remaining(),
    );
  });

  it("reserves the version's maxTokens for the response", () => {
    const tight = createRunContextBudget(SMALL_WINDOW_MODEL, undefined, 190_000);
    const loose = createRunContextBudget(SMALL_WINDOW_MODEL, undefined, 1_000);
    expect(tight!.remaining()).toBeLessThan(loose!.remaining());
  });

  it("does not let legitimate Korean input exhaust the budget by itself", () => {
    // 67,000 Hangul chars sit well inside haiku's 200k-token window; the old
    // 2-tokens/char estimate priced them over the whole default budget and
    // every tool call answered "budget exhausted" from turn 0.
    const budget = createRunContextBudget(SMALL_WINDOW_MODEL, undefined, undefined)!;
    budget.chargeMessage({ role: "user", content: "가".repeat(67_000) });
    expect(budget.remaining()).toBeGreaterThan(0);
  });

  it("returns undefined when maxTokens leaves no capacity to derive", () => {
    // A zero budget would answer every tool call "budget exhausted" from turn
    // 0 and blame a budget the run never got to fill; the provider is the one
    // that rejects an impossible maxTokens coherently.
    expect(createRunContextBudget(SMALL_WINDOW_MODEL, undefined, 200_000)).toBeUndefined();
  });

  it("reserves the larger output cap when maxTokens is unset and a fallback exists", () => {
    // With no explicit maxTokens the wire carries none, so whichever model
    // serves the call may generate up to its own registry maximum — reserving
    // only the primary's would let a bigger-output fallback overflow the
    // window the minimum was taken against.
    const withFallback = createRunContextBudget(
      SMALL_WINDOW_MODEL,
      "anthropic/claude-sonnet-5",
      undefined,
    )!;
    const alone = createRunContextBudget(SMALL_WINDOW_MODEL, undefined, undefined)!;
    expect(withFallback.remaining()).toBeLessThan(alone.remaining());
  });
});

describe("RunContextBudget charging and fitting", () => {
  it("charges an image part at the flat rate, not its base64 length", () => {
    const budget = createRunContextBudget(SMALL_WINDOW_MODEL, undefined, 190_000)!;
    const before = budget.remaining();
    budget.chargeMessage({
      role: "user",
      content: [
        { type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(500_000)}` } },
      ],
    });
    expect(before - budget.remaining()).toBe(IMAGE_PART_TOKENS);
  });

  it("fits text that has room without touching it", () => {
    const budget = createRunContextBudget(SMALL_WINDOW_MODEL, undefined, 190_000)!;
    const text = "x".repeat(600);
    const before = budget.remaining();
    expect(budget.fitText(text)).toEqual({ text, truncated: false, kept: true });
    expect(budget.remaining()).toBe(before - 200);
    expect(budget.truncated()).toBe(false);
  });

  it("reserves the suffix inside the fit instead of appending it on top", () => {
    const budget = createRunContextBudget(SMALL_WINDOW_MODEL, undefined, 190_000)!;
    const capacity = budget.remaining();
    const suffix = "\n…(truncated)";
    const fitted = budget.fitText("x".repeat(100_000), { suffix });
    expect(fitted.truncated).toBe(true);
    expect(fitted.kept).toBe(true);
    expect(fitted.text.endsWith(suffix)).toBe(true);
    // Everything inserted — kept text AND marker — fits what the budget had.
    expect(estimateContextTokens(fitted.text)).toBeLessThanOrEqual(capacity);
  });

  it("keeps nothing under minKeepChars and charges nothing for it", () => {
    const budget = createRunContextBudget(SMALL_WINDOW_MODEL, undefined, 190_000)!;
    budget.chargeText("z".repeat(3 * (budget.remaining() - 100)));
    const before = budget.remaining();
    const fitted = budget.fitText("x".repeat(10_000), { minKeepChars: 500 });
    expect(fitted).toEqual({ text: "", truncated: true, kept: false });
    expect(budget.remaining()).toBe(before);
  });

  it("tracks post-exhaustion protocol strings as debt", () => {
    const budget = createRunContextBudget(SMALL_WINDOW_MODEL, undefined, 190_000)!;
    budget.chargeText("z".repeat(3 * budget.remaining()));
    expect(budget.remaining()).toBe(0);
    budget.chargeText("Error: tool result omitted");
    // Still zero outwardly, but the debt keeps later fits at zero too.
    expect(budget.remaining()).toBe(0);
    expect(budget.fitText("anything")).toEqual({ text: "", truncated: true, kept: false });
  });

  it("cuts text past the remaining budget and remembers the cut", () => {
    const budget = createRunContextBudget(SMALL_WINDOW_MODEL, undefined, 190_000)!;
    const fitted = budget.fitText("x".repeat(100_000));
    expect(fitted.truncated).toBe(true);
    expect(fitted.text.length).toBeLessThan(100_000);
    expect(fitted.text.length).toBeGreaterThan(0);
    expect(budget.truncated()).toBe(true);
    // What was kept was charged: nothing more fits.
    expect(budget.fitText("y".repeat(10_000)).text.length).toBeLessThan(10_000);
  });

  it("returns nothing once the budget is exhausted", () => {
    const budget = createRunContextBudget(SMALL_WINDOW_MODEL, undefined, 190_000)!;
    budget.fitText("x".repeat(100_000));
    while (budget.remaining() > 0) {
      budget.chargeText("z".repeat(3_000));
    }
    expect(budget.fitText("more")).toEqual({ text: "", truncated: true, kept: false });
  });
});

describe("runAgent context budget", () => {
  const TOOL = [{ type: "function" as const, function: { name: "search", parameters: {} } }];

  function toolLoopChannel(): FakeChannel {
    return new FakeChannel([
      [toolCallChunk(0, "call_1", "search", "{}"), usageChunk(1, 1)],
      [contentChunk("answered"), usageChunk(1, 1)],
    ]);
  }

  it("truncates tool output to the model's context budget and warns once", async () => {
    const channel = toolLoopChannel();
    const deps: AgentDeps = {
      channel,
      callMcpTool: async () => ({ text: "x".repeat(100_000) }),
    };
    const input: RunAgentInput = {
      projectName: "p",
      model: SMALL_WINDOW_MODEL,
      parameters: SMALL_BUDGET_PARAMS,
      messages: [{ role: "user", content: "go" }],
      mcpTools: TOOL,
    };

    const chunks = await collect(runAgent(deps, input));

    const result = chunks.find((c) => c.toolResult)?.toolResult?.content ?? "";
    expect(result).toContain("the run's context budget is exhausted");
    expect(result.length).toBeLessThan(40_000);
    expect(
      chunks.filter((c) => c.warning?.includes("context budget")),
    ).toHaveLength(1);
    // The next request carries the truncated result, bounded well below the
    // raw 100k chars — this is the provider 400 not happening.
    const toolMessage = channel.seenParams[1]?.messages.find((m) => m.role === "tool");
    expect(String(toolMessage?.content).length).toBeLessThan(40_000);
  });

  it("counts a transfer's answer against the budget", async () => {
    const channel = new FakeChannel([
      [toolCallChunk(0, "call_t", "transfer_to_agent", '{"agent_name":"child","message":"do it"}'), usageChunk(1, 1)],
      [contentChunk("done"), usageChunk(1, 1)],
    ]);
    const deps: AgentDeps = {
      channel,
      // eslint-disable-next-line require-yield
      runSubagent: async function* () {
        return "y".repeat(80_000);
      },
    };
    const input: RunAgentInput = {
      projectName: "p",
      model: SMALL_WINDOW_MODEL,
      parameters: SMALL_BUDGET_PARAMS,
      messages: [{ role: "user", content: "go" }],
      subagents: [{ name: "child", description: "", type: "local" }],
    };

    const chunks = await collect(runAgent(deps, input));

    expect(chunks.some((c) => c.warning?.includes("context budget"))).toBe(true);
    const context = channel.seenParams[1]?.messages.at(-1);
    const text = String(context?.content);
    expect(text).toContain("…[truncated: the run's context budget is exhausted]");
    expect(text.length).toBeLessThan(40_000);
  });

  it("leaves a run with headroom byte-identical", async () => {
    const payload = "x".repeat(50_000);
    const channel = toolLoopChannel();
    const deps: AgentDeps = {
      channel,
      callMcpTool: async () => ({ text: payload }),
    };
    const input: RunAgentInput = {
      projectName: "p",
      model: HUGE_WINDOW_MODEL,
      messages: [{ role: "user", content: "go" }],
      mcpTools: TOOL,
    };

    const chunks = await collect(runAgent(deps, input));

    expect(chunks.find((c) => c.toolResult)?.toolResult?.content).toBe(payload);
    expect(chunks.some((c) => c.warning)).toBe(false);
    const toolMessage = channel.seenParams[1]?.messages.find((m) => m.role === "tool");
    expect(toolMessage?.content).toBe(payload);
  });

  it("runs an unregistered model unbudgeted, exactly as before the budget", async () => {
    const payload = "x".repeat(100_000);
    const channel = toolLoopChannel();
    const deps: AgentDeps = {
      channel,
      callMcpTool: async () => ({ text: payload }),
    };
    const input: RunAgentInput = {
      projectName: "p",
      model: "custom/private-model",
      messages: [{ role: "user", content: "go" }],
      mcpTools: TOOL,
    };

    const chunks = await collect(runAgent(deps, input));

    expect(chunks.find((c) => c.toolResult)?.toolResult?.content).toBe(payload);
    expect(chunks.some((c) => c.warning)).toBe(false);
  });
});
