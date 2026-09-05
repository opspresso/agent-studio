import { describe, expect, it } from "vitest";
import {
  createRunContextBudget,
  estimateContextTokens,
  IMAGE_PART_TOKENS,
} from "@/application/llm/contextBudget";
import { runAgent, type AgentDeps, type RunAgentInput } from "@/application/llm/engine";
import type { EngineChunk } from "@/domain/llm/types";
import { contentChunk, FakeChannel, reasoningChunk, toolCallChunk, usageChunk } from "./fakeChannel";

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

  it("takes each model's output reserve from its own window", () => {
    // A 1,050,000-token primary with a 200,000-token fallback. Reserving the
    // *primary's* 128,000-token output from the *fallback's* window left 70,000
    // — 6.7% of the window every call in the run was actually served from — and
    // a Slack answer that truncated its own tool output to fit a limit neither
    // model has. The pair is bounded by the fallback's own capacity.
    const budget = createRunContextBudget(
      "openai/gpt-5.6-luna",
      "anthropic/claude-haiku-4.5",
      undefined,
    )!;
    expect(budget.remaining()).toBe(134_000);
    expect(budget.remaining()).toBe(
      createRunContextBudget("anthropic/claude-haiku-4.5", undefined, undefined)!.remaining(),
    );
  });

  it("does not charge a fallback's larger output cap against a smaller window", () => {
    // The other order of the same mistake. A fallback that may generate more
    // has the bigger window to generate into; what has to fit is each model's
    // own input plus its own output, which is what the capacities compare.
    const withFallback = createRunContextBudget(
      SMALL_WINDOW_MODEL,
      "anthropic/claude-sonnet-5",
      undefined,
    )!;
    const alone = createRunContextBudget(SMALL_WINDOW_MODEL, undefined, undefined)!;
    expect(withFallback.remaining()).toBe(alone.remaining());
  });

  it("still lets an explicit maxTokens bound both models", () => {
    // Set, it is what the wire carries for whichever model serves the call, so
    // it is the reserve for both and the smaller *window* governs.
    const budget = createRunContextBudget("openai/gpt-5.6-luna", SMALL_WINDOW_MODEL, 190_000)!;
    expect(budget.remaining()).toBe(200_000 - 190_000 - 2_000);
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

  it.each(["search", "transfer_to_agent"])(
    "reserves the assistant turn before fitting a %s result into the next request",
    async (toolName) => {
      const text = "a".repeat(6_000);
      const reasoning = "r".repeat(3_000);
      const args = { agent_name: "child", message: "m".repeat(3_000) };
      const channel = new FakeChannel([
        [
          contentChunk(text),
          reasoningChunk(reasoning),
          toolCallChunk(0, "call_1", toolName, JSON.stringify(args)),
          usageChunk(1, 1),
        ],
        [contentChunk("answered"), usageChunk(1, 1)],
      ]);
      const chunks = await collect(runAgent(
        {
          channel,
          callMcpTool: async () => ({ text: "x".repeat(100_000) }),
          runSubagent: async function* () {
            return "x".repeat(100_000);
          },
        },
        {
          projectName: "p",
          model: SMALL_WINDOW_MODEL,
          parameters: SMALL_BUDGET_PARAMS,
          messages: [{ role: "user", content: "go" }],
          mcpTools: TOOL,
          subagents: [{ name: "child", description: "", type: "local" }],
        },
      ));

      expect(channel.seenParams).toHaveLength(2);
      const request = channel.seenParams[1]!;
      const assistant = request.messages.find((message) => message.role === "assistant")!;
      expect(assistant.content).toBe(text);
      expect(assistant.reasoning_content).toBe(reasoning);
      expect(JSON.parse(assistant.tool_calls![0]!.function!.arguments!)).toEqual(args);
      // Measure what actually reaches the channel, not the budget's clamped
      // remaining() counter: charging too late hides an overflow as debt.
      const tokens = request.messages.reduce(
        (total, message) => total +
          estimateContextTokens(String(message.content ?? "")) +
          estimateContextTokens(message.reasoning_content ?? "") +
          estimateContextTokens(message.tool_calls ? JSON.stringify(message.tool_calls) : ""),
        estimateContextTokens(JSON.stringify(request.tools)),
      );
      const capacity = createRunContextBudget(
        SMALL_WINDOW_MODEL, undefined, SMALL_BUDGET_PARAMS.maxTokens,
      )!.remaining();
      expect(tokens).toBeLessThanOrEqual(capacity);
      // A second charge would unnecessarily discard another assistant turn's
      // worth of useful result text instead of filling the available room.
      expect(tokens).toBeGreaterThan(capacity - 100);
      expect(chunks.filter((chunk) => chunk.warning?.includes("context budget"))).toHaveLength(1);
    },
  );

  it("stops budgeting a run that had no room from the start, and says so", async () => {
    // Two configurations reach this: an input that fills the window on its own,
    // and a model whose own `maxTokens` leaves almost none of its window — the
    // registry has some at a few thousand tokens, which is less than a version's
    // tool declarations alone. Kept, the budget answers every tool call "budget
    // exhausted" from turn 0 and blames a budget the run never got to fill,
    // while the overflow it exists to prevent is already in the request.
    const channel = toolLoopChannel();
    const deps: AgentDeps = { channel, callMcpTool: async () => ({ text: "result" }) };
    const input: RunAgentInput = {
      projectName: "p",
      model: SMALL_WINDOW_MODEL,
      // An 8,000-token budget, and 10,000 tokens of input to put in it.
      parameters: SMALL_BUDGET_PARAMS,
      messages: [{ role: "user", content: "x".repeat(30_000) }],
      mcpTools: TOOL,
    };

    const chunks = await collect(runAgent(deps, input));

    expect(
      chunks.filter((c) => c.warning?.includes("already fill the model's context window")),
    ).toHaveLength(1);
    // Unbudgeted, so the tool result arrives whole rather than as an omission
    // error, and nothing claims the run's budget cut it.
    expect(chunks.find((c) => c.toolResult)?.toolResult?.content).toBe("result");
    expect(chunks.some((c) => c.warning?.includes("context budget"))).toBe(false);
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

  it("never cuts a tool result through a surrogate pair, and the marker tells the truth", async () => {
    // "a" + 100k emoji: the 200k per-turn boundary lands between the halves
    // of a pair. A raw slice kept the high half — a string DynamoDB refuses
    // and the provider receives as a lone surrogate escape.
    const payload = `a${"😀".repeat(100_000)}`;
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

    const result = chunks.find((c) => c.toolResult)?.toolResult?.content ?? "";
    const markerAt = result.indexOf("\n…(truncated: kept");
    expect(markerAt).toBeGreaterThan(0);
    const kept = result.slice(0, markerAt);
    const lastCode = kept.charCodeAt(kept.length - 1);
    expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false);
    // Backing off the pair keeps 199,999 of the 200,001 chars — and the
    // marker states what was actually kept, not the pre-backoff room.
    expect(result).toContain(`kept ${kept.length} of ${payload.length} chars`);
    expect(kept.length).toBe(199_999);
  });

  it("carries only the run budget's marker when it cut below the per-turn cap", async () => {
    // 250k chars: the per-turn cap would keep 200k, the run budget only ~24k.
    // The old order appended "kept 200000 of 250000 chars" first and let the
    // run fit cut that text again — a surviving claim about a length the
    // final text no longer had.
    const channel = toolLoopChannel();
    const deps: AgentDeps = {
      channel,
      callMcpTool: async () => ({ text: "x".repeat(250_000) }),
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
    expect(result).toContain("(truncated: the run's context budget is exhausted)");
    expect(result).not.toContain("kept 200000");
    expect(result.length).toBeLessThan(40_000);
  });

  it("debits the turn only what the run budget let in, so a second call is blamed on the right budget", async () => {
    // Two 250k results in one turn. The old cut set the per-turn remainder to
    // zero even though only ~24k entered, so the second call was refused as
    // "this turn's tool output budget is exhausted" — telling the model to
    // request less next time when the run's budget was what had run out.
    const channel = new FakeChannel([
      [
        toolCallChunk(0, "call_1", "search", "{}"),
        toolCallChunk(1, "call_2", "search", "{}"),
        usageChunk(1, 1),
      ],
      [contentChunk("answered"), usageChunk(1, 1)],
    ]);
    const deps: AgentDeps = {
      channel,
      callMcpTool: async () => ({ text: "x".repeat(250_000) }),
    };
    const input: RunAgentInput = {
      projectName: "p",
      model: SMALL_WINDOW_MODEL,
      parameters: SMALL_BUDGET_PARAMS,
      messages: [{ role: "user", content: "go" }],
      mcpTools: TOOL,
    };

    const chunks = await collect(runAgent(deps, input));

    const results = chunks.filter((c) => c.toolResult).map((c) => c.toolResult?.content ?? "");
    expect(results).toHaveLength(2);
    expect(results[1]).toContain("the run's context budget is exhausted");
    expect(results[1]).not.toContain("this turn's tool output budget");
  });

  it("prices the masked text the context actually receives, not the shorter raw one", async () => {
    // 2,000 addresses: each mask token runs 8 chars longer than its original,
    // so charging the raw text and inserting the masked one undercounted by
    // ~16k chars — the drift between the estimate and the wire that the
    // budget's headroom exists to absorb, spent silently.
    const payload = Array.from(
      { length: 2_000 },
      (_, i) => `user${String(i).padStart(4, "0")}@mail.com`,
    ).join(" ");
    const channel = toolLoopChannel();
    const deps: AgentDeps = {
      channel,
      callMcpTool: async () => ({ text: payload }),
    };
    const input: RunAgentInput = {
      projectName: "p",
      model: SMALL_WINDOW_MODEL,
      parameters: { maxTokens: 190_000, piiFiltering: true },
      messages: [{ role: "user", content: "go" }],
      mcpTools: TOOL,
    };

    await collect(runAgent(deps, input));

    // What goes on the wire is the masked, budget-fitted text: within what the
    // ~8k-token budget prices (~24k ASCII chars), not that plus mask growth.
    const toolMessage = channel.seenParams[1]?.messages.find((m) => m.role === "tool");
    expect(String(toolMessage?.content).length).toBeLessThan(26_000);
  });

  it("prices a transfer's masked answer, not its raw one", async () => {
    const payload = Array.from(
      { length: 2_000 },
      (_, i) => `user${String(i).padStart(4, "0")}@mail.com`,
    ).join(" ");
    const channel = new FakeChannel([
      [toolCallChunk(0, "call_t", "transfer_to_agent", '{"agent_name":"child","message":"do it"}'), usageChunk(1, 1)],
      [contentChunk("done"), usageChunk(1, 1)],
    ]);
    const deps: AgentDeps = {
      channel,
      // eslint-disable-next-line require-yield
      runSubagent: async function* () {
        return payload;
      },
    };
    const input: RunAgentInput = {
      projectName: "p",
      model: SMALL_WINDOW_MODEL,
      parameters: { maxTokens: 190_000, piiFiltering: true },
      messages: [{ role: "user", content: "go" }],
      subagents: [{ name: "child", description: "", type: "local" }],
    };

    const chunks = await collect(runAgent(deps, input));

    expect(chunks.some((c) => c.warning?.includes("context budget"))).toBe(true);
    const context = channel.seenParams[1]?.messages.at(-1);
    expect(String(context?.content).length).toBeLessThan(26_000);
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

  it("charges a refusal it wrote itself, but never replaces its reason with the budget's", async () => {
    // Two calls in one response: a 250k tool result that spends the whole
    // per-turn budget, then a call whose arguments did not parse. The refusal
    // would go through the same fit as the tool output, so once the budget
    // was gone it came back as "this turn's tool output budget is exhausted" —
    // telling the model to request less data about a call that failed to parse.
    // It is bounded by construction, so it is charged and handed back whole.
    const channel = new FakeChannel([
      [
        toolCallChunk(0, "call_1", "search", "{}"),
        toolCallChunk(1, "call_2", "search", "{not json"),
        usageChunk(1, 1),
      ],
      [contentChunk("answered"), usageChunk(1, 1)],
    ]);
    const deps: AgentDeps = {
      channel,
      callMcpTool: async () => ({ text: "x".repeat(250_000) }),
    };
    const input: RunAgentInput = {
      projectName: "p",
      model: HUGE_WINDOW_MODEL,
      messages: [{ role: "user", content: "go" }],
      mcpTools: TOOL,
    };

    const chunks = await collect(runAgent(deps, input));

    const results = chunks.filter((c) => c.toolResult).map((c) => c.toolResult?.content ?? "");
    expect(results).toHaveLength(2);
    expect(results[0]).toContain("this turn's tool output budget is exhausted");
    expect(results[1]).toContain("did not parse as a JSON object");
    // And the context got the same string, not a longer one it was never
    // billed for: what enters is what is charged.
    const stored = channel.seenParams[1]?.messages.find((m) => m.tool_call_id === "call_2");
    expect(stored?.content).toBe(results[1]);
  });

  it("keeps a builtin's own refusal too, and still fits what a provider sent back", async () => {
    // The same split one level down. `GenerateImage` writes both its argument
    // refusal and its provider-failure text into one variable, so charging the
    // whole branch whole would leave an unbounded provider body unfitted, and
    // fitting it would answer "request less data" to a call that forgot its
    // prompt. Two calls in one exhausted turn, one of each kind.
    const channel = new FakeChannel([
      [
        toolCallChunk(0, "call_1", "search", "{}"),
        toolCallChunk(1, "call_2", "GenerateImage", "{}"),
        toolCallChunk(2, "call_3", "GenerateImage", '{"prompt":"a fox"}'),
        usageChunk(1, 1),
      ],
      [contentChunk("answered"), usageChunk(1, 1)],
    ]);
    const deps: AgentDeps = {
      channel,
      callMcpTool: async () => ({ text: "x".repeat(250_000) }),
      generateImage: async () => {
        throw new Error(`provider said: ${"y".repeat(250_000)}`);
      },
    };
    const input: RunAgentInput = {
      projectName: "p",
      model: HUGE_WINDOW_MODEL,
      messages: [{ role: "user", content: "go" }],
      mcpTools: TOOL,
    };

    const chunks = await collect(runAgent(deps, input));

    const byCall = new Map(
      chunks.filter((c) => c.toolResult).map((c) => [c.toolResult!.toolCallId, c.toolResult!.content]),
    );
    expect(byCall.get("call_2")).toBe("Error: GenerateImage requires a prompt.");
    // The provider's body is what the fit exists for; it does not survive whole.
    expect(byCall.get("call_3")).toContain("budget is exhausted");
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
