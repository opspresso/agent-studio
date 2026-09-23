import { createToolSchemaValidator } from "@/infrastructure/llm/toolSchema";
import { scriptedModels } from "./scriptedModels";
import { describe, expect, it, vi } from "vitest";
import type { ChannelParams, LlmChannel } from "./channelFixtures";
import type { ContentPart, EngineChunk } from "@/domain/llm/types";
import {
  buildTransferTranscript,
  runAgent,
  type AgentDeps,
  type RunAgentInput,
} from "@/application/runtime";
import {
  contentChunk,
  FakeChannel,
  mergedDeltaChunk,
  reasoningChunk,
  toolCallChunk,
  usageChunk,
} from "./fakeChannel";

async function collect(gen: AsyncGenerator<EngineChunk>): Promise<EngineChunk[]> {
  const chunks: EngineChunk[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

const MODEL = "google/gemini-2.5-flash";

describe("runAgent tool loop", () => {
  it("executes a tool call, feeds the result back, and returns the final answer", async () => {
    const channel = new FakeChannel([
      [toolCallChunk(0, "call_1", "getWeather", '{"city":"Seoul"}'), usageChunk(10, 5)],
      [contentChunk("It is sunny."), usageChunk(8, 4)],
    ]);
    const recorded: unknown[] = [];
    const callMcpTool = vi.fn(async (name: string) => {
      expect(name).toBe("getWeather");
      return { text: "sunny" };
    });
    const deps: AgentDeps = { createToolSchemaValidator,
      channel,
      recordUsage: async (r) => {
        recorded.push(r);
      },
      callMcpTool,
    };
    const input: RunAgentInput = {
      projectName: "weather-bot",
      model: MODEL,
      systemPrompt: "You are helpful.",
      messages: [{ role: "user", content: "weather in Seoul?" }],
      mcpTools: [
        { type: "function", function: { name: "getWeather", description: "", parameters: {} } },
      ],
    };

    const chunks = await collect(runAgent(deps, input));

    expect(callMcpTool).toHaveBeenCalledTimes(1);
    const toolResult = chunks.find((c) => c.toolResult);
    expect(toolResult?.toolResult).toEqual({
      toolCallId: "call_1",
      name: "getWeather",
      content: "sunny",
    });
    const finalText = chunks
      .filter((c) => c.delta?.content)
      .map((c) => c.delta?.content)
      .join("");
    expect(finalText).toBe("It is sunny.");
    expect(chunks.some((c) => c.done)).toBe(true);
    // One usage record per model call (two turns).
    expect(recorded).toHaveLength(2);
  });

  /**
   * A router knows what it charged; the registry only predicts it. When the
   * channel reports a cost, that is what gets recorded — otherwise a route
   * whose price differs from its vendor's is billed at the vendor's rate
   * forever, and nothing in the dashboard says the number is a guess.
   */
  it("records the cost the channel reported, in preference to the registry's", async () => {
    const channel = new FakeChannel([[contentChunk("Answered."), usageChunk(1_000_000, 0, 0, 0.42)]]);
    const recorded: Array<{ costUsd: number }> = [];
    const chunks = await collect(
      runAgent(
        { createToolSchemaValidator, channel, recordUsage: async (r) => void recorded.push(r as { costUsd: number }) },
        {
          projectName: "router-bot",
          model: MODEL,
          systemPrompt: "You are helpful.",
          messages: [{ role: "user", content: "hi" }],
        },
      ),
    );

    // The registry would price a million input tokens of this model at $0.30.
    expect(recorded[0]?.costUsd).toBeCloseTo(0.42, 10);
    expect(chunks.find((c) => c.usage)?.usage?.costUsd).toBeCloseTo(0.42, 10);
  });

  it("falls back to registry pricing when the channel reports no cost", async () => {
    const channel = new FakeChannel([[contentChunk("Answered."), usageChunk(1_000_000, 0)]]);
    const recorded: Array<{ costUsd: number }> = [];
    await collect(
      runAgent(
        { createToolSchemaValidator, channel, recordUsage: async (r) => void recorded.push(r as { costUsd: number }) },
        {
          projectName: "direct-bot",
          model: MODEL,
          systemPrompt: "You are helpful.",
          messages: [{ role: "user", content: "hi" }],
        },
      ),
    );

    expect(recorded[0]?.costUsd).toBeCloseTo(0.3, 10);
  });

  /**
   * An MCP tool's name is the server's own — `aws___search_documentation` — and
   * says nothing about which connection answered it once a configuration has several
   * attached. It rides on the display name, the way a skill's and a transfer's
   * target already do, and never on what the context receives.
   */
  it("names the server that served an MCP tool on the result", async () => {
    const channel = new FakeChannel([
      [toolCallChunk(0, "call_1", "search_docs", "{}"), usageChunk(10, 5)],
      [contentChunk("Found it."), usageChunk(8, 4)],
    ]);
    const chunks = await collect(
      runAgent(
        { createToolSchemaValidator, channel, callMcpTool: async () => ({ text: "a page" }) },
        {
          projectName: "docs-bot",
          model: MODEL,
          systemPrompt: "You are helpful.",
          messages: [{ role: "user", content: "find the docs" }],
          mcpTools: [
            { type: "function", function: { name: "search_docs", description: "", parameters: {} } },
          ],
          mcpServers: [{ name: "aws-knowledge", description: "", toolNames: ["search_docs"] }],
        },
      ),
    );

    expect(chunks.find((c) => c.toolResult)?.toolResult).toEqual({
      toolCallId: "call_1",
      name: "aws-knowledge: search_docs",
      content: "a page",
    });
  });

  it("leaves a tool no connected server claims under its own name", async () => {
    const channel = new FakeChannel([
      [toolCallChunk(0, "call_1", "search_docs", "{}"), usageChunk(10, 5)],
      [contentChunk("Found it."), usageChunk(8, 4)],
    ]);
    const chunks = await collect(
      runAgent(
        { createToolSchemaValidator, channel, callMcpTool: async () => ({ text: "a page" }) },
        {
          projectName: "docs-bot",
          model: MODEL,
          systemPrompt: "You are helpful.",
          messages: [{ role: "user", content: "find the docs" }],
          mcpTools: [
            { type: "function", function: { name: "search_docs", description: "", parameters: {} } },
          ],
          mcpServers: [{ name: "aws-knowledge", description: "", toolNames: ["something_else"] }],
        },
      ),
    );

    expect(chunks.find((c) => c.toolResult)?.toolResult).toMatchObject({ name: "search_docs" });
  });

  it("labels a Skill load's toolResult with the loaded skill name", async () => {
    const channel = new FakeChannel([
      [toolCallChunk(0, "call_1", "Skill", '{"skill_name":"image-generation"}'), usageChunk(10, 5)],
      [contentChunk("Loaded."), usageChunk(8, 4)],
    ]);
    const deps: AgentDeps = { createToolSchemaValidator,
      channel,
      recordUsage: async () => {},
      loadSkillContent: async () => "# skill content",
    };
    const input: RunAgentInput = {
      projectName: "p",
      model: MODEL,
      systemPrompt: "s",
      messages: [{ role: "user", content: "draw" }],
      skills: [{ name: "image-generation", description: "" }],
    };

    const chunks = await collect(runAgent(deps, input));

    expect(chunks.find((c) => c.toolResult)?.toolResult).toEqual({
      toolCallId: "call_1",
      name: "Skill: image-generation",
      content: "# skill content",
    });
  });

  it("dispatches a builtin's name to MCP when that builtin is not offered", async () => {
    // `loadSkillContent` is injected on every agent run, so the dep alone cannot
    // decide who serves a call named `Skill`. With no skills connected the
    // builtin is not offered, and the name belongs to whoever declared it.
    const channel = new FakeChannel([
      [toolCallChunk(0, "call_1", "Skill", '{"skill_name":"x"}'), usageChunk(1, 1)],
      [contentChunk("done"), usageChunk(1, 1)],
    ]);
    const called: string[] = [];
    const deps: AgentDeps = { createToolSchemaValidator,
      channel,
      recordUsage: async () => {},
      loadSkillContent: async () => "# never reached",
      callMcpTool: async (name) => {
        called.push(name);
        return { text: "mcp answered" };
      },
    };
    const input: RunAgentInput = {
      projectName: "p",
      model: MODEL,
      systemPrompt: "s",
      messages: [{ role: "user", content: "go" }],
      mcpTools: [{ type: "function", function: { name: "Skill", parameters: {} } }],
    };

    const chunks = await collect(runAgent(deps, input));

    expect(called).toEqual(["Skill"]);
    expect(chunks.find((c) => c.toolResult)?.toolResult?.content).toBe("mcp answered");
  });

  it("runs a tool call that arrives in the same delta as assistant content", async () => {
    // Gateways (vLLM/LiteLLM) and reasoning shims put content and tool_calls in
    // ONE delta. Treating the delta fields as mutually exclusive silently drops
    // the call and the loop ends as if the model never asked for a tool.
    const channel = new FakeChannel([
      [
        mergedDeltaChunk(
          { content: "Let me check. " },
          { index: 0, id: "call_1", name: "getWeather", args: '{"city":"Seoul"}' },
        ),
        usageChunk(10, 5),
      ],
      [contentChunk("It is sunny."), usageChunk(8, 4)],
    ]);
    const callMcpTool = vi.fn(async () => ({ text: "sunny" }));
    const deps: AgentDeps = { createToolSchemaValidator, channel, recordUsage: async () => {}, callMcpTool };

    const chunks = await collect(
      runAgent(deps, {
        projectName: "p",
        model: MODEL,
        messages: [{ role: "user", content: "weather?" }],
        mcpTools: [{ type: "function", function: { name: "getWeather", parameters: {} } }],
      }),
    );

    expect(callMcpTool).toHaveBeenCalledWith("getWeather", { city: "Seoul" });
    // The text that shared the delta still streams, and the loop continues.
    // Two turns spoke, so a blank line separates them — this would read
    // "Let me check. It is sunny." with the turns run together.
    const text = chunks
      .filter((c) => c.delta?.content)
      .map((c) => c.delta?.content)
      .join("");
    expect(text).toBe("Let me check. \n\nIt is sunny.");
    expect(chunks.some((c) => c.done)).toBe(true);
  });

  it("runs a tool call that shares a delta with reasoning content", async () => {
    const channel = new FakeChannel([
      [
        mergedDeltaChunk(
          { reasoningContent: "thinking…" },
          { index: 0, id: "call_r", name: "search", args: "{}" },
        ),
        usageChunk(3, 1),
      ],
      [contentChunk("found"), usageChunk(2, 1)],
    ]);
    const callMcpTool = vi.fn(async () => ({ text: "results" }));
    const deps: AgentDeps = { createToolSchemaValidator, channel, recordUsage: async () => {}, callMcpTool };

    const chunks = await collect(
      runAgent(deps, {
        projectName: "p",
        model: MODEL,
        messages: [{ role: "user", content: "search" }],
        mcpTools: [{ type: "function", function: { name: "search", parameters: {} } }],
        // The reasoning half of the shared delta is only visible to a run that
        // asked for it; the tool call in the same delta is not conditional.
        parameters: { reasoningTrace: true },
      }),
    );

    expect(callMcpTool).toHaveBeenCalledTimes(1);
    expect(chunks.some((c) => c.delta?.reasoningContent === "thinking…")).toBe(true);
  });

  it("stops at the turn guard instead of looping forever", async () => {
    // The model keeps asking for a tool; the guard must cap the loop.
    const channel = new FakeChannel([
      [toolCallChunk(0, "call_a", "loop", "{}"), usageChunk(1, 1)],
      [toolCallChunk(0, "call_b", "loop", "{}"), usageChunk(1, 1)],
      [toolCallChunk(0, "call_c", "loop", "{}"), usageChunk(1, 1)],
    ]);
    const recorded: unknown[] = [];
    const deps: AgentDeps = { createToolSchemaValidator,
      channel,
      recordUsage: async (r) => {
        recorded.push(r);
      },
      callMcpTool: async () => ({ text: "ok" }),
    };
    const input: RunAgentInput = {
      projectName: "looper",
      model: MODEL,
      messages: [{ role: "user", content: "go" }],
      maxTurn: 2,
      mcpTools: [{ type: "function", function: { name: "loop", parameters: {} } }],
    };

    const chunks = await collect(runAgent(deps, input));

    // turn 0 and turn 1 run; turn 2 hits the guard and returns with no answer.
    expect(recorded).toHaveLength(2);
    expect(chunks.some((c) => c.done)).toBe(false);
    // The guard is not silent: the user is told why there is no answer, and
    // consumers are told why the stream ended instead of inferring it from the
    // absence of `done`.
    expect(chunks.some((c) => c.warning?.includes("turn limit (2 turns)"))).toBe(true);
    expect(chunks.at(-1)).toEqual({ author: undefined, finishReason: "turn-limit" });
  });



  /**
   * The tool's `agent_name` is an enum, but an enum is advisory — a model that
   * invents a name would have the transfer attempted, refused a layer down as
   * an authored `error`, and reported to the reader as a delegation that came
   * back empty. It is a call the model can retry, so it is answered like an
   * unloadable skill: a tool error naming what it could have asked for.
   */



});





describe("tools + reasoning_effort provider constraint", () => {
  const TOOL = { type: "function" as const, function: { name: "lookup", parameters: {} } };

  it("forces reasoning_effort to 'none' for models that reject the combination", async () => {
    const channel = new FakeChannel([[contentChunk("ok"), usageChunk(1, 1)]]);
    const deps: AgentDeps = { createToolSchemaValidator, channel, recordUsage: async () => {} };

    await collect(
      runAgent(deps, {
        projectName: "p",
        model: "openai/gpt-5.6-sol",
        messages: [{ role: "user", content: "hi" }],
        parameters: { reasoningEffort: "medium" },
        mcpTools: [TOOL],
      }),
    );

    expect(channel.seenParams[0]?.reasoningEffort).toBe("none");
    expect(channel.seenParams[0]?.tools).toHaveLength(1);
  });

  it("sends an explicit 'none' even when no effort is configured", async () => {
    const channel = new FakeChannel([[contentChunk("ok"), usageChunk(1, 1)]]);
    const deps: AgentDeps = { createToolSchemaValidator, channel, recordUsage: async () => {} };

    await collect(
      runAgent(deps, {
        projectName: "p",
        model: "openai/gpt-5.6-sol",
        messages: [{ role: "user", content: "hi" }],
        mcpTools: [TOOL],
      }),
    );

    // Omitting the field falls back to the provider's reasoning default and
    // still 400s — the constraint must always send an explicit "none".
    expect(channel.seenParams[0]?.reasoningEffort).toBe("none");
  });

  it("keeps the configured effort for models that accept the combination", async () => {
    const channel = new FakeChannel([[contentChunk("ok"), usageChunk(1, 1)]]);
    const deps: AgentDeps = { createToolSchemaValidator, channel, recordUsage: async () => {} };

    await collect(
      runAgent(deps, {
        projectName: "p",
        model: "openai/gpt-5.4",
        messages: [{ role: "user", content: "hi" }],
        parameters: { reasoningEffort: "medium" },
        mcpTools: [TOOL],
      }),
    );

    expect(channel.seenParams[0]?.reasoningEffort).toBe("medium");
  });

  it("keeps the configured effort for constrained models when no tools are wired", async () => {
    const channel = new FakeChannel([[contentChunk("ok"), usageChunk(1, 1)]]);
    const deps: AgentDeps = { createToolSchemaValidator, channel, recordUsage: async () => {} };

    await collect(
      runAgent(deps, {
        projectName: "p",
        model: "openai/gpt-5.6-sol",
        messages: [{ role: "user", content: "hi" }],
        parameters: { reasoningEffort: "medium" },
      }),
    );

    expect(channel.seenParams[0]?.reasoningEffort).toBe("medium");
  });
});

describe("recording the run's reasoning", () => {
  const TOOL = { type: "function" as const, function: { name: "lookup", parameters: {} } };

  function thinkingRun() {
    return new FakeChannel([
      [reasoningChunk("weighing it"), contentChunk("answer"), usageChunk(3, 2)],
    ]);
  }

  it("emits nothing unless the configuration asked for it", async () => {
    const channel = thinkingRun();
    const deps: AgentDeps = { createToolSchemaValidator, channel, recordUsage: async () => {} };

    const chunks = await collect(
      runAgent(deps, {
        projectName: "p",
        model: MODEL,
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(chunks.some((c) => c.delta?.reasoningContent !== undefined)).toBe(false);
    expect(chunks.some((c) => c.delta?.content === "answer")).toBe(true);
  });

  it("emits the thinking when it did", async () => {
    const channel = thinkingRun();
    const deps: AgentDeps = { createToolSchemaValidator, channel, recordUsage: async () => {} };

    const chunks = await collect(
      runAgent(deps, {
        projectName: "p",
        model: MODEL,
        messages: [{ role: "user", content: "hi" }],
        parameters: { reasoningTrace: true },
      }),
    );

    expect(chunks.some((c) => c.delta?.reasoningContent === "weighing it")).toBe(true);
  });

  it("still returns the turn's thinking to the provider with the gate off", async () => {
    // The gate is on the yield alone. A turn's `reasoning_content` belongs to
    // the assistant message that declared its tool calls, and dropping it
    // changes what the model is sent — this is what makes the accumulation
    // behind the gate un-deletable.
    const channel = new FakeChannel([
      [reasoningChunk("first thought"), toolCallChunk(0, "call_1", "lookup", "{}"), usageChunk(1, 1)],
      [contentChunk("done"), usageChunk(1, 1)],
    ]);
    const deps: AgentDeps = { createToolSchemaValidator,
      channel: scriptedModels(channel),
      recordUsage: async () => {},
      callMcpTool: async () => ({ text: "result" }),
    };

    await collect(
      runAgent(deps, {
        projectName: "p",
        model: MODEL,
        messages: [{ role: "user", content: "hi" }],
        mcpTools: [TOOL],
      }),
    );

    const replayed = channel.seenParams[1]?.messages.find((m) => m.role === "assistant");
    expect(replayed?.reasoning_content).toBe("first thought");
  });

  it("separates one turn's thinking from the next with a blank line", async () => {
    const channel = new FakeChannel([
      [reasoningChunk("look it up"), toolCallChunk(0, "call_1", "lookup", "{}"), usageChunk(1, 1)],
      [reasoningChunk("now answer"), contentChunk("done"), usageChunk(1, 1)],
    ]);
    const deps: AgentDeps = { createToolSchemaValidator,
      channel: scriptedModels(channel),
      recordUsage: async () => {},
      callMcpTool: async () => ({ text: "result" }),
    };

    const chunks = await collect(
      runAgent(deps, {
        projectName: "p",
        model: MODEL,
        messages: [{ role: "user", content: "hi" }],
        mcpTools: [TOOL],
        parameters: { reasoningTrace: true },
      }),
    );

    const reasoning = chunks
      .filter((c) => c.delta?.reasoningContent)
      .map((c) => c.delta?.reasoningContent)
      .join("");
    expect(reasoning).toBe("look it up\n\nnow answer");
  });

  it("says so once when the model refuses to reason while it holds tools", async () => {
    const channel = new FakeChannel([
      [toolCallChunk(0, "call_1", "lookup", "{}"), usageChunk(1, 1)],
      [contentChunk("done"), usageChunk(1, 1)],
    ]);
    const deps: AgentDeps = { createToolSchemaValidator,
      channel: scriptedModels(channel),
      recordUsage: async () => {},
      callMcpTool: async () => ({ text: "result" }),
    };

    const chunks = await collect(
      runAgent(deps, {
        projectName: "p",
        model: "openai/gpt-5.6-sol",
        messages: [{ role: "user", content: "hi" }],
        mcpTools: [TOOL],
        parameters: { reasoningTrace: true, reasoningEffort: "medium" },
      }),
    );

    const warnings = chunks.filter((c) => c.warning?.includes("does not reason while it can call tools"));
    expect(warnings).toHaveLength(1);
  });

  it("stays quiet about the constraint when the run did not ask to record", async () => {
    const channel = new FakeChannel([[contentChunk("ok"), usageChunk(1, 1)]]);
    const deps: AgentDeps = { createToolSchemaValidator, channel, recordUsage: async () => {} };

    const chunks = await collect(
      runAgent(deps, {
        projectName: "p",
        model: "openai/gpt-5.6-sol",
        messages: [{ role: "user", content: "hi" }],
        mcpTools: [TOOL],
        parameters: { reasoningEffort: "medium" },
      }),
    );

    expect(chunks.some((c) => c.warning !== undefined)).toBe(false);
  });

  it("shows the reader restored thinking while the model keeps the masked copy", async () => {
    // The mask/restore boundary is the same one `content` sits on: the filter
    // bounds what the *model* sees, not what a person reads back. The
    // replacement token is minted per run, so the model here is one that echoes
    // back whatever it was actually sent — which is the only way to see both
    // sides of the boundary at once.
    const seen: ChannelParams[] = [];
    const channel: LlmChannel = {
      chatCompletion: async () => {
        throw new Error("not used");
      },
      async *chatCompletionStream(params: ChannelParams) {
        seen.push(params);
        const asked = String(params.messages[params.messages.length - 1]?.content ?? "");
        const token = /\[\[PII:[^\]]*\]\]/.exec(asked)?.[0] ?? "";
        if (seen.length === 1) {
          yield reasoningChunk(`mailing ${token}`);
          yield toolCallChunk(0, "call_1", "lookup", "{}");
          yield usageChunk(1, 1);
          return;
        }
        yield contentChunk("done");
        yield usageChunk(1, 1);
      },
    };
    const deps: AgentDeps = { createToolSchemaValidator,
      channel: scriptedModels(channel),
      recordUsage: async () => {},
      callMcpTool: async () => ({ text: "result" }),
    };

    const chunks = await collect(
      runAgent(deps, {
        projectName: "p",
        model: MODEL,
        messages: [{ role: "user", content: "mail me at a@b.com" }],
        mcpTools: [TOOL],
        parameters: { piiFiltering: true, reasoningTrace: true },
      }),
    );

    const shown = chunks
      .filter((c) => c.delta?.reasoningContent)
      .map((c) => c.delta?.reasoningContent)
      .join("");
    expect(shown).toBe("mailing a@b.com");

    const replayed = seen[1]?.messages.find((m) => m.role === "assistant");
    expect(replayed?.reasoning_content).toContain("[[PII:");
    expect(replayed?.reasoning_content).not.toContain("a@b.com");
  });

  it("says so when the whole answer arrived as thinking it is not recording", async () => {
    // Some open-weight models put the answer in `reasoning_content`. With the
    // trace off, `content` is empty for the whole run and every surface shows a
    // blank reply for a call that was billed in full.
    const channel = new FakeChannel([[reasoningChunk("the answer, as thinking"), usageChunk(3, 9)]]);
    const deps: AgentDeps = { createToolSchemaValidator, channel, recordUsage: async () => {} };

    const chunks = await collect(
      runAgent(deps, {
        projectName: "p",
        model: MODEL,
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(chunks.some((c) => c.warning?.includes("answered inside its reasoning"))).toBe(true);
  });

  it("says it at the turn guard too, where the other warning would mislead", async () => {
    // "The budget ran out" claims there was an answer coming. There was not —
    // the words went onto the other axis and were dropped.
    const channel = new FakeChannel([
      [reasoningChunk("thinking, not speaking"), toolCallChunk(0, "call_1", "lookup", "{}"), usageChunk(1, 1)],
    ]);
    const deps: AgentDeps = { createToolSchemaValidator,
      channel: scriptedModels(channel),
      recordUsage: async () => {},
      callMcpTool: async () => ({ text: "result" }),
    };

    const chunks = await collect(
      runAgent(deps, {
        projectName: "p",
        model: MODEL,
        messages: [{ role: "user", content: "hi" }],
        mcpTools: [TOOL],
        maxTurn: 1,
      }),
    );

    expect(chunks.some((c) => c.warning?.includes("answered inside its reasoning"))).toBe(true);
    expect(chunks.some((c) => c.finishReason === "turn-limit")).toBe(true);
  });

  it("points a recording run at its reasoning rather than telling it to record", async () => {
    // The bubble is blank either way; what differs is whether the answer is
    // somewhere the reader can go and open.
    const channel = new FakeChannel([[reasoningChunk("the answer, as thinking"), usageChunk(1, 1)]]);

    const chunks = await collect(
      runAgent(
        { createToolSchemaValidator, channel, recordUsage: async () => {} },
        {
          projectName: "p",
          model: MODEL,
          messages: [{ role: "user", content: "hi" }],
          parameters: { reasoningTrace: true },
        },
      ),
    );

    expect(chunks.some((c) => c.warning?.includes("in the recorded reasoning"))).toBe(true);
    expect(chunks.some((c) => c.warning?.includes("does not record"))).toBe(false);
  });

  it("says when the provider reports the size of its thinking and withholds it", async () => {
    // The common OpenAI shape. Nothing downstream can tell this run from one
    // whose configuration simply did not opt in — both are a count with no text — so
    // the engine, which holds the flag, is the only place that can say it.
    const channel = new FakeChannel([
      [contentChunk("answered"), usageChunk(3, 4010, undefined, undefined, 4000)],
    ]);

    const chunks = await collect(
      runAgent(
        { createToolSchemaValidator, channel, recordUsage: async () => {} },
        {
          projectName: "p",
          model: MODEL,
          messages: [{ role: "user", content: "hi" }],
          parameters: { reasoningTrace: true },
        },
      ),
    );

    expect(chunks.filter((c) => c.warning?.includes("does not return the thinking itself"))).toHaveLength(1);
  });

  it("stays quiet about the withheld text when the configuration never asked for it", async () => {
    // Every configuration written before this feature is this run: a reasoning model,
    // the checkbox off, a provider reporting the count anyway.
    const channel = new FakeChannel([
      [contentChunk("answered"), usageChunk(3, 4010, undefined, undefined, 4000)],
    ]);

    const chunks = await collect(
      runAgent(
        { createToolSchemaValidator, channel, recordUsage: async () => {} },
        { projectName: "p", model: MODEL, messages: [{ role: "user", content: "hi" }] },
      ),
    );

    expect(chunks.some((c) => c.warning !== undefined)).toBe(false);
  });

  it("stays quiet about it when the run also spoke", async () => {
    const channel = new FakeChannel([
      [reasoningChunk("thinking"), contentChunk("said"), usageChunk(1, 1)],
    ]);

    const chunks = await collect(
      runAgent(
        { createToolSchemaValidator, channel, recordUsage: async () => {} },
        { projectName: "p", model: MODEL, messages: [{ role: "user", content: "hi" }] },
      ),
    );

    expect(chunks.some((c) => c.warning?.includes("answered inside its reasoning"))).toBe(false);
  });

  it("carries reasoning tokens on the usage chunk, and only when reported", async () => {
    const withTokens = new FakeChannel([[contentChunk("ok"), usageChunk(3, 9, undefined, undefined, 7)]]);
    const without = new FakeChannel([[contentChunk("ok"), usageChunk(3, 9)]]);

    for (const [channel, expected] of [
      [withTokens, 7],
      [without, undefined],
    ] as const) {
      const recorded: unknown[] = [];
      const chunks = await collect(
        runAgent(
          { createToolSchemaValidator, channel, recordUsage: async (r) => void recorded.push(r) },
          { projectName: "p", model: MODEL, messages: [{ role: "user", content: "hi" }] },
        ),
      );
      const usage = chunks.find((c) => c.usage)?.usage;
      expect(usage?.reasoningTokens).toBe(expected);
      // Inside `outputTokens` already — pricing it again would double-bill.
      expect(usage?.outputTokens).toBe(9);
      expect(recorded[0]).not.toHaveProperty("reasoningTokens");
    }
  });
});

describe("runAgent GenerateImage builtin", () => {
  it("generates an image, yields an image chunk, and continues the loop", async () => {
    const { FakeChannel: FC } = await import("./fakeChannel");
    const channel = new FC([
      [toolCallChunk(0, "call_img", "GenerateImage", '{"prompt":"a red fox","size":"1024x1024"}'), usageChunk(10, 5)],
      [contentChunk("Here is your fox."), usageChunk(8, 4)],
    ]);
    const generateImage = vi.fn(async (prompt: string) => {
      expect(prompt).toBe("a red fox");
      return { b64: "aW1n", mimeType: "image/png", model: "openai/gpt-image-1", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
    });
    const deps: AgentDeps = { createToolSchemaValidator, channel, generateImage };
    const chunks = await collect(
      runAgent(deps, {
        projectName: "artist",
        model: MODEL,
        messages: [{ role: "user", content: "draw a fox" }],
      }),
    );
    const imageChunk = chunks.find((c) => c.image);
    // The model rides on the chunk: the builtin draws with the configuration's image
    // model, which is not the model this run is talking to, and the artifact row
    // is written from what the chunk says.
    expect(imageChunk?.image).toMatchObject({
      b64: "aW1n",
      mimeType: "image/png",
      prompt: "a red fox",
      model: "openai/gpt-image-1",
    });
    const finalText = chunks.map((c) => c.delta?.content ?? "").join("");
    expect(finalText).toContain("Here is your fox.");
    // the image tool is offered because generateImage is wired
    expect(channel.seenParams[0]?.tools?.some((t) => t.function.name === "GenerateImage")).toBe(true);
  });

  it("does not offer the tool when generateImage is absent", async () => {
    const { FakeChannel: FC } = await import("./fakeChannel");
    const channel = new FC([[contentChunk("hi"), usageChunk(1, 1)]]);
    await collect(
      runAgent({ createToolSchemaValidator, channel }, { projectName: "p", model: MODEL, messages: [{ role: "user", content: "hi" }] }),
    );
    expect(channel.seenParams[0]?.tools?.some((t) => t.function.name === "GenerateImage") ?? false).toBe(false);
  });
});

describe("runAgent separates the configuration's prompt from what the engine appends", () => {
  async function systemPromptFor(input: Partial<Parameters<typeof runAgent>[1]>): Promise<string> {
    const channel = new FakeChannel([[contentChunk("ok"), usageChunk(1, 1)]]);
    await collect(
      runAgent(
        { createToolSchemaValidator, channel, loadSkillContent: async () => "body", loadAgent: async () => { throw new Error("Unexpected delegation"); } },
        {
          projectName: "p",
          model: MODEL,
          systemPrompt: "You are the front desk.",
          messages: [{ role: "user", content: "hi" }],
          ...input,
        },
      ),
    );
    return String(channel.seenParams[0]?.messages[0]?.content);
  }

  it("marks where the configuration's prompt ends and the generated block begins", async () => {
    // Without the break the generated `##` sections are indistinguishable from
    // headings the prompt author wrote, and "your own instructions" — which the
    // routing rule is anchored to — has no referent.
    const content = await systemPromptFor({
      subagents: [{ name: "painter", description: "draws pictures" }],
    });
    expect(content).toContain("You are the front desk.\n\n---\n\n# Runtime capabilities");
    expect(content.indexOf("# Runtime capabilities")).toBeLessThan(
      content.indexOf("## Available Agents"),
    );
  });

  it("states when to use a capability exactly once, naming only what the run has", async () => {
    const content = await systemPromptFor({
      subagents: [{ name: "painter", description: "draws pictures" }],
    });
    // One routing sentence, in the framing — not one per section.
    expect(content).toContain(
      "Your instructions define your role and constraints. Within that role, transfer to an agent whose description covers the request better than your instructions do.",
    );
    // This run has no skills and no MCP servers, so neither is offered as an option.
    expect(content).not.toContain("load a skill when");
    expect(content).not.toContain("call a tool when");
  });

  it("ranks every capability the run does have in that one sentence", async () => {
    const content = await systemPromptFor({
      skills: [{ name: "writing", description: "how to write" }],
      subagents: [{ name: "painter", description: "draws pictures" }],
      mcpTools: ["search_repos", "get_pr", "search_docs"].map((name) => ({ type: "function", function: { name, parameters: {} } })),
      mcpServers: [{ name: "github", description: "repos", toolNames: ["search_repos"] }],
    });
    expect(content).toContain(
      "Within that role, load a skill when you need guidance on how to carry it out, call a tool when you need data or an action from outside this conversation, or transfer to an agent whose description covers the request better than your instructions do.",
    );
  });

  it("leaves a configuration that reaches nothing exactly as its author wrote it", async () => {
    // No capabilities means no block, so there is no boundary to announce and
    // the prompt the author sees in the editor is the prompt that is sent.
    expect(await systemPromptFor({})).toBe("You are the front desk.");
  });
});

describe("runAgent MCP server system prompt", () => {
  it("appends a Connected MCP Servers table when mcpServers are provided", async () => {
    const channel = new FakeChannel([[contentChunk("ok"), usageChunk(1, 1)]]);
    await collect(
      runAgent(
        { createToolSchemaValidator, channel },
        {
          projectName: "p",
          model: MODEL,
          systemPrompt: "base prompt",
          messages: [{ role: "user", content: "hi" }],
          mcpTools: ["search_repos", "get_pr", "search_docs"].map((name) => ({ type: "function", function: { name, parameters: {} } })),
          mcpServers: [
            { name: "github", description: "Internal GitHub access", toolNames: ["search_repos", "get_pr"] },
            { name: "docs", description: "", toolNames: ["search_docs"] },
          ],
        },
      ),
    );
    const system = channel.seenParams[0]?.messages[0];
    expect(system?.role).toBe("system");
    const content = String(system?.content);
    expect(content).toContain("base prompt");
    expect(content).toContain("## Connected MCP Servers");
    expect(content).toContain("| github | Internal GitHub access | search_repos, get_pr |");
    expect(content).toContain("| docs |  | search_docs |");
  });

  it("adds no MCP section when mcpServers is absent", async () => {
    const channel = new FakeChannel([[contentChunk("ok"), usageChunk(1, 1)]]);
    await collect(
      runAgent(
        { createToolSchemaValidator, channel },
        {
          projectName: "p",
          model: MODEL,
          systemPrompt: "base prompt",
          messages: [{ role: "user", content: "hi" }],
          mcpTools: ["search_repos", "get_pr", "search_docs"].map((name) => ({ type: "function", function: { name, parameters: {} } })),
        },
      ),
    );
    const content = String(channel.seenParams[0]?.messages[0]?.content);
    expect(content).not.toContain("Connected MCP Servers");
  });

  it("keeps the table intact when a description spans lines or contains a pipe", async () => {
    // Descriptions are a single markdown table cell. A newline would end the
    // row early and orphan the remaining servers; a pipe would add a column.
    const channel = new FakeChannel([[contentChunk("ok"), usageChunk(1, 1)]]);
    await collect(
      runAgent(
        { createToolSchemaValidator, channel },
        {
          projectName: "p",
          model: MODEL,
          messages: [{ role: "user", content: "hi" }],
          mcpTools: ["a", "b"].map((name) => ({ type: "function", function: { name, parameters: {} } })),
          mcpServers: [
            { name: "multi", description: "  first line\n\n  second | piped  ", toolNames: ["a"] },
            { name: "after", description: "still listed", toolNames: ["b"] },
          ],
        },
      ),
    );

    const content = String(channel.seenParams[0]?.messages[0]?.content);
    expect(content).toContain("| multi | first line second \\| piped | a |");
    // The row after the offending one is still a row of the same table.
    expect(content).toContain("| after | still listed | b |");
    const tableLines = content
      .split("\n")
      .filter((line) => line.startsWith("| ") && !line.startsWith("|--"));
    expect(tableLines).toHaveLength(3); // header + 2 servers
  });
});

describe("runAgent skill and subagent system prompt", () => {
  it("lists skills in a table and leaves the tool's own parameters to the tool", async () => {
    const channel = new FakeChannel([[contentChunk("ok"), usageChunk(1, 1)]]);
    await collect(
      runAgent(
        { createToolSchemaValidator, channel, loadSkillContent: async () => "" },
        {
          projectName: "p",
          model: MODEL,
          systemPrompt: "base prompt",
          messages: [{ role: "user", content: "hi" }],
          skills: [{ name: "writing", description: "how to write" }],
        },
      ),
    );

    const content = String(channel.seenParams[0]?.messages[0]?.content);
    expect(content).toContain("## Available Skills");
    expect(content).toContain("| writing | how to write |");
    // `file_path` is documented on the Skill tool's parameter, not twice.
    expect(content).not.toContain("file_path");
    const skillTool = channel.seenParams[0]?.tools?.find((t) => t.function.name === "Skill");
    const skillName = (
      skillTool?.function.parameters as { properties: { skill_name: { enum: string[] } } }
    ).properties.skill_name;
    expect(skillName.enum).toEqual(["writing"]);
  });






});

describe("runAgent image input", () => {
  const DATA_URL = "data:image/png;base64,aGVsbG8=";
  const IMAGE_MESSAGE: RunAgentInput["messages"] = [
    {
      role: "user",
      content: [
        { type: "text", text: "what is in this picture?" },
        { type: "image_url", image_url: { url: DATA_URL } },
      ],
    },
  ];

  it("passes content parts through to the channel untouched", async () => {
    const channel = new FakeChannel([[contentChunk("a cat"), usageChunk(1, 1)]]);

    await collect(
      runAgent(
        { createToolSchemaValidator, channel },
        { projectName: "p", model: MODEL, messages: IMAGE_MESSAGE },
      ),
    );

    // The SDK makes default image detail explicit; text and image bytes are unchanged.
    expect(channel.seenParams[0]?.messages.at(-1)?.content).toEqual((IMAGE_MESSAGE[0]?.content as ContentPart[]).map((part) => part.type === "image_url" ? { ...part, image_url: { ...part.image_url, detail: "auto" } } : part));
  });

  it("rejects a model that does not accept image input", async () => {
    const channel = new FakeChannel([[contentChunk("never"), usageChunk(1, 1)]]);

    await expect(
      collect(
        runAgent(
          { createToolSchemaValidator, channel },
          { projectName: "p", model: "xai/grok-code-fast-1", messages: IMAGE_MESSAGE },
        ),
      ),
    ).rejects.toThrow("does not accept image input");
    expect(channel.calls).toBe(0);
  });

  it("rejects a model missing from the registry", async () => {
    const channel = new FakeChannel([[contentChunk("never"), usageChunk(1, 1)]]);

    await expect(
      collect(
        runAgent({ createToolSchemaValidator, channel }, { projectName: "p", model: "who/knows", messages: IMAGE_MESSAGE }),
      ),
    ).rejects.toThrow("not in the registry");
  });

  it("drops a fallback model that cannot read the images", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // First script rejects with a retryable error so a live fallback would be used.
    const channel = new FakeChannel([[contentChunk("ok"), usageChunk(1, 1)]]);

    await collect(
      runAgent(
        { createToolSchemaValidator, channel },
        {
          projectName: "p",
          model: MODEL,
          fallbackModel: "xai/grok-code-fast-1",
          messages: IMAGE_MESSAGE,
        },
      ),
    );

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("fallback skipped"));
    warn.mockRestore();
  });

  it("keeps the image payload out of PII masking", async () => {
    const channel = new FakeChannel([[contentChunk("ok"), usageChunk(1, 1)]]);

    await collect(
      runAgent(
        { createToolSchemaValidator, channel },
        {
          projectName: "p",
          model: MODEL,
          parameters: { piiFiltering: true },
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "mail me at a@b.com" },
                { type: "image_url", image_url: { url: DATA_URL } },
              ],
            },
          ],
        },
      ),
    );

    const parts = channel.seenParams[0]?.messages.at(-1)?.content;
    expect(Array.isArray(parts)).toBe(true);
    const [text, image] = parts as ContentPart[];
    expect(JSON.stringify(text)).not.toContain("a@b.com");
    expect(image).toEqual({ type: "image_url", image_url: { url: DATA_URL, detail: "auto" } });
  });
});

describe("runAgent skill system prompt", () => {
  it("keeps the skill table intact when a description spans lines", async () => {
    // Synced skills take their description from SKILL.md frontmatter, which is
    // not constrained to one line the way the console input is.
    const channel = new FakeChannel([[contentChunk("ok"), usageChunk(1, 1)]]);
    await collect(
      runAgent(
        { createToolSchemaValidator, channel, loadSkillContent: async () => "" },
        {
          projectName: "p",
          model: MODEL,
          messages: [{ role: "user", content: "hi" }],
          skills: [
            { name: "wrapped", description: "line one\nline two" },
            { name: "blank", description: "" },
          ],
        },
      ),
    );

    const content = String(channel.seenParams[0]?.messages[0]?.content);
    expect(content).toContain("| wrapped | line one line two |");
    expect(content).toContain("| blank | No description |");
  });
});

/**
 * A tool-using run speaks more than once, and every consumer flattens those
 * turns by appending deltas. Within a turn that is how streaming works; across
 * turns it ran one statement into the next with nothing between them.
 */
describe("runAgent separates what consecutive turns say", () => {
  const deps = (channel: FakeChannel): AgentDeps => ({ createToolSchemaValidator,
    channel,
    recordUsage: async () => {},
    callMcpTool: async () => ({ text: "ok" }),
  });
  const input = (): RunAgentInput => ({
    projectName: "p",
    model: MODEL,
    systemPrompt: "",
    messages: [{ role: "user", content: "go" }],
    mcpTools: [{ type: "function", function: { name: "look", description: "", parameters: {} } }],
  });
  const joined = (chunks: EngineChunk[]) =>
    chunks
      .filter((c) => c.delta?.content)
      .map((c) => c.delta?.content)
      .join("");

  it("puts a blank line between a turn that spoke and the next that speaks", async () => {
    const channel = new FakeChannel([
      [contentChunk("확인해볼게요."), toolCallChunk(0, "c1", "look", "{}"), usageChunk(1, 1)],
      [contentChunk('"demo" 를 찾았어요.'), usageChunk(1, 1)],
    ]);

    expect(joined(await collect(runAgent(deps(channel), input())))).toBe(
      '확인해볼게요.\n\n"demo" 를 찾았어요.',
    );
  });

  it("does not break up one turn's own stream", async () => {
    const channel = new FakeChannel([[contentChunk("한"), contentChunk("문장"), usageChunk(1, 1)]]);

    expect(joined(await collect(runAgent(deps(channel), input())))).toBe("한문장");
  });

  it("adds nothing before an answer that follows a silent tool turn", async () => {
    // The common shape: the model calls a tool without commentary, then answers.
    // A separator here would open the reply with a blank line.
    const channel = new FakeChannel([
      [toolCallChunk(0, "c1", "look", "{}"), usageChunk(1, 1)],
      [contentChunk("답입니다."), usageChunk(1, 1)],
    ]);

    expect(joined(await collect(runAgent(deps(channel), input())))).toBe("답입니다.");
  });

  /**
   * With PII filtering on, a turn's words reach the reader through the stream
   * restorer, which holds back whatever suffix could still turn out to be half
   * a replacement token. A turn the provider cut just after `[[PII:` is
   * delivered entirely by the end-of-turn flush — and "this turn spoke" has to
   * be true of that too, or the next turn's first word runs into it.
   */
  it("counts a turn delivered only by the restorer's flush as having spoken", async () => {
    const channel = new FakeChannel([
      [contentChunk("[[PII:"), toolCallChunk(0, "c1", "look", "{}"), usageChunk(1, 1)],
      [contentChunk("답입니다."), usageChunk(1, 1)],
    ]);
    const withPii: RunAgentInput = {
      ...input(),
      // Creates a replacement, so the restorer has a token to buffer against.
      messages: [{ role: "user", content: "mail me at a@b.com" }],
      parameters: { piiFiltering: true },
    };

    expect(joined(await collect(runAgent(deps(channel), withPii)))).toBe("[[PII:\n\n답입니다.");
  });

  it("separates three turns, not just the first pair", async () => {
    const channel = new FakeChannel([
      [contentChunk("하나"), toolCallChunk(0, "c1", "look", "{}"), usageChunk(1, 1)],
      [contentChunk("둘"), toolCallChunk(1, "c2", "look", "{}"), usageChunk(1, 1)],
      [contentChunk("셋"), usageChunk(1, 1)],
    ]);

    expect(joined(await collect(runAgent(deps(channel), input())))).toBe("하나\n\n둘\n\n셋");
  });
});

/**
 * A turn bigger than the whole transfer budget would be dropped outright,
 * which lost the question along with whatever made it long. A turn carrying an
 * attached document is exactly that shape — the document's text is flattened
 * into the same line — so every document turn evicted itself and the child never
 * learned the conversation was about one.
 */
describe("buildTransferTranscript with an oversized turn", () => {
  it("keeps the head of a turn too long to fit, rather than losing it whole", () => {
    const { text, dropped } = buildTransferTranscript(
      [
        { role: "user", content: `[Attached file "q3.pdf"]\n${"x".repeat(30_000)}\nsummarise this` },
        { role: "assistant", content: "here is the summary" },
        { role: "user", content: "now transfer" },
      ],
      "Assistant",
    );

    expect(text).toContain("here is the summary");
    // The oversized turn is present in some form, and says it was cut.
    expect(text).toContain('[Attached file "q3.pdf"');
    expect(text).toContain("[truncated]");
    expect(dropped).toBe(1);
  });

  it("still omits a turn when what would survive is too short to mean anything", () => {
    const filler = { role: "assistant" as const, content: "y".repeat(7_800) };
    const { text, dropped } = buildTransferTranscript(
      [
        { role: "user", content: "x".repeat(30_000) },
        filler,
        { role: "user", content: "now transfer" },
      ],
      "Assistant",
    );

    // The filler spent the budget; half a sentence would read as a whole one.
    expect(text).not.toContain("[truncated]");
    expect(text).toContain("earlier turn(s) omitted");
    expect(dropped).toBe(1);
  });

  it("never cuts through a character", () => {
    const { text } = buildTransferTranscript(
      [
        { role: "user", content: "\u{1F600}".repeat(20_000) },
        { role: "user", content: "now transfer" },
      ],
      "Assistant",
    );

    expect(text.isWellFormed()).toBe(true);
  });
});

describe("provider output cut (finish_reason: length)", () => {
  it("announces output-limit instead of done when the final turn was cut", async () => {
    const { finishReasonChunk } = await import("./fakeChannel");
    const channel = new FakeChannel([
      [contentChunk("partial answ"), finishReasonChunk("length"), usageChunk(2, 1)],
    ]);
    const deps: AgentDeps = { createToolSchemaValidator, channel: scriptedModels(channel), recordUsage: async () => {} };

    const chunks = await collect(
      runAgent(deps, { projectName: "p", model: MODEL, messages: [{ role: "user", content: "go" }] }),
    );

    expect(chunks.some((c) => c.done)).toBe(false);
    expect(chunks.some((c) => c.warning?.includes("output limit"))).toBe(true);
    expect(chunks.at(-1)).toEqual({ author: undefined, finishReason: "output-limit" });
  });

  it("keeps a finished turn announced as done", async () => {
    const { finishReasonChunk } = await import("./fakeChannel");
    const channel = new FakeChannel([
      [contentChunk("whole answer"), finishReasonChunk("stop"), usageChunk(2, 1)],
    ]);
    const deps: AgentDeps = { createToolSchemaValidator, channel, recordUsage: async () => {} };

    const chunks = await collect(
      runAgent(deps, { projectName: "p", model: MODEL, messages: [{ role: "user", content: "go" }] }),
    );

    expect(chunks.some((c) => c.done)).toBe(true);
    expect(chunks.some((c) => c.finishReason)).toBe(false);
  });

  it("announces a turn cut mid-tool-call and refuses the call whose arguments were cut", async () => {
    // The cut lands inside the arguments JSON: the old mapping parsed the
    // fragment to `{}` and ran the tool with empty arguments, silently.
    const { finishReasonChunk } = await import("./fakeChannel");
    const channel = new FakeChannel([
      [
        toolCallChunk(0, "call_1", "search", '{"query":"seou'),
        finishReasonChunk("length"),
        usageChunk(2, 1),
      ],
      [contentChunk("recovered"), usageChunk(2, 1)],
    ]);
    const callMcpTool = vi.fn(async () => ({ text: "found" }));
    const deps: AgentDeps = { createToolSchemaValidator, channel, callMcpTool };

    const chunks = await collect(
      runAgent(deps, {
        projectName: "p",
        model: MODEL,
        messages: [{ role: "user", content: "go" }],
        mcpTools: [{ type: "function", function: { name: "search", parameters: {} } }],
      }),
    );

    // Never dispatched with `{}` — the model never asked for that call.
    expect(callMcpTool).not.toHaveBeenCalled();
    expect(chunks.filter((chunk) => chunk.error)).toEqual([]);
    expect(chunks.some((c) => c.warning?.includes("output limit"))).toBe(true);
    expect(channel.calls).toBe(2);
    expect(chunks.find((chunk) => chunk.toolResult)?.toolResult?.content).toContain("parsing tool arguments");
    expect(chunks.at(-1)?.done).toBe(true);
  });

  it("still runs the calls of a cut turn whose arguments arrived whole", async () => {
    const { finishReasonChunk } = await import("./fakeChannel");
    const channel = new FakeChannel([
      [
        toolCallChunk(0, "call_1", "search", '{"query":"seoul"}'),
        finishReasonChunk("length"),
        usageChunk(2, 1),
      ],
      [contentChunk("answered"), usageChunk(2, 1)],
    ]);
    const callMcpTool = vi.fn(async () => ({ text: "found" }));
    const deps: AgentDeps = { createToolSchemaValidator, channel, callMcpTool };

    const chunks = await collect(
      runAgent(deps, {
        projectName: "p",
        model: MODEL,
        messages: [{ role: "user", content: "go" }],
        mcpTools: [{ type: "function", function: { name: "search", parameters: {} } }],
      }),
    );

    expect(callMcpTool).toHaveBeenCalledWith("search", { query: "seoul" });
    // The cut is still announced — the plan may have had more calls behind it.
    expect(chunks.some((c) => c.warning?.includes("output limit"))).toBe(true);
    expect(chunks.some((c) => c.done)).toBe(true);
  });

  it("reports arguments that did not parse without an output cut as a model defect", async () => {
    const channel = new FakeChannel([
      [toolCallChunk(0, "call_1", "search", '{"query": broken'), usageChunk(2, 1)],
      [contentChunk("recovered"), usageChunk(2, 1)],
    ]);
    const callMcpTool = vi.fn(async () => ({ text: "found" }));
    const deps: AgentDeps = { createToolSchemaValidator, channel, callMcpTool };

    const chunks = await collect(
      runAgent(deps, {
        projectName: "p",
        model: MODEL,
        messages: [{ role: "user", content: "go" }],
        mcpTools: [{ type: "function", function: { name: "search", parameters: {} } }],
      }),
    );

    expect(callMcpTool).not.toHaveBeenCalled();
    expect(chunks.filter((chunk) => chunk.error)).toEqual([]);
    const result = chunks.find((chunk) => chunk.toolResult)?.toolResult?.content;
    expect(result).toContain("parsing tool arguments");
    expect(result).not.toContain("query");
    expect(channel.calls).toBe(2);
    expect(chunks.some((c) => c.warning)).toBe(false);
    expect(chunks.at(-1)?.done).toBe(true);
  });
});

/**
 * A run that spends its whole budget calling tools would end with a warning
 * where the answer should be — every turn paid for, nothing to show. The last
 * turn is offered no tools and told so, which is the only way the wrap-up can
 * be relied on: a model that is still looping at the ceiling is exactly the one
 * that ignores an instruction to stop.
 */
describe("the final turn", () => {
  const toolDef = { type: "function" as const, function: { name: "loop", parameters: {} } };
  const loopingInput = (maxTurn: number): RunAgentInput => ({
    projectName: "looper",
    model: MODEL,
    messages: [{ role: "user", content: "go" }],
    maxTurn,
    mcpTools: [toolDef],
  });

  it("offers no tools on the last turn and answers with what it has", async () => {
    const channel = new FakeChannel([
      [toolCallChunk(0, "call_a", "loop", "{}"), usageChunk(1, 1)],
      [toolCallChunk(0, "call_b", "loop", "{}"), usageChunk(1, 1)],
      [contentChunk("Here is what I found so far."), usageChunk(2, 2)],
    ]);
    const deps: AgentDeps = { createToolSchemaValidator,
      channel,
      recordUsage: async () => {},
      callMcpTool: async () => ({ text: "ok" }),
    };

    const chunks = await collect(runAgent(deps, loopingInput(3)));

    // Turns 0 and 1 carry the tool set; the last one carries none, so the
    // provider cannot answer with another call.
    expect(channel.seenParams[0]?.tools).toBeDefined();
    expect(channel.seenParams[1]?.tools).toBeDefined();
    expect(channel.seenParams[2]?.tools).toBeUndefined();
    // And the model is told why, rather than left to guess at a silently
    // shrunken tool set.
    const lastTurnMessages = channel.seenParams[2]?.messages ?? [];
    expect(lastTurnMessages[0]).toMatchObject({ role: "system" });
    expect(String(lastTurnMessages[0]?.content)).toContain("final turn");

    expect(chunks.some((c) => c.delta?.content === "Here is what I found so far.")).toBe(true);
    // The answer is real, but it is not a finish: it is what the run could say
    // with its budget spent, and a consumer reading `done` could not tell.
    expect(chunks.some((c) => c.done)).toBe(false);
    expect(chunks.at(-1)).toEqual({ author: undefined, finishReason: "turn-limit" });
    expect(chunks.find((c) => c.warning)?.warning).toContain("reached its turn limit (3 turns)");
  });

  it("never appears in a run that finishes inside its budget", async () => {
    const channel = new FakeChannel([[contentChunk("done in one."), usageChunk(1, 1)]]);
    const deps: AgentDeps = { createToolSchemaValidator,
      channel,
      recordUsage: async () => {},
      callMcpTool: async () => ({ text: "ok" }),
    };

    const chunks = await collect(runAgent(deps, loopingInput(50)));

    expect(channel.seenParams[0]?.tools).toBeDefined();
    expect(channel.seenParams[0]?.messages.some((m) => String(m.content).includes("final turn"))).toBe(
      false,
    );
    expect(chunks.some((c) => c.warning)).toBe(false);
    expect(chunks.at(-1)).toEqual({ author: undefined, done: true });
  });

  it("does not run tools a last turn asked for anyway", async () => {
    // Nothing will read the results — the money would buy nothing — and the
    // wording must not claim an answer that was never written.
    const channel = new FakeChannel([
      [toolCallChunk(0, "call_a", "loop", "{}"), usageChunk(1, 1)],
      [toolCallChunk(0, "call_b", "loop", "{}"), usageChunk(1, 1)],
    ]);
    const callMcpTool = vi.fn(async () => ({ text: "ok" }));
    const deps: AgentDeps = { createToolSchemaValidator, channel, recordUsage: async () => {}, callMcpTool };

    const chunks = await collect(runAgent(deps, loopingInput(2)));

    expect(callMcpTool).toHaveBeenCalledTimes(1);
    expect(chunks.find((c) => c.warning)?.warning).toContain(
      "stopped at its turn limit (2 turns) before the model finished answering",
    );
    expect(chunks.at(-1)).toEqual({ author: undefined, finishReason: "turn-limit" });
  });


});



describe("empty provider errors", () => {
  it("never yields an error chunk with an empty message", async () => {
    const channel = {
      async chatCompletion(): Promise<never> {
        throw new Error("");
      },
      // eslint-disable-next-line require-yield
      async *chatCompletionStream(): AsyncGenerator<never> {
        // An Error("") has a message every truthy gate skips while
        // chunkTermination still classifies the chunk as an ending.
        throw new Error("");
      },
    };
    const deps: AgentDeps = { createToolSchemaValidator, channel: scriptedModels(channel), recordUsage: async () => {} };

    const chunks = await collect(
      runAgent(deps, { projectName: "p", model: MODEL, messages: [{ role: "user", content: "go" }] }),
    );

    expect(chunks.at(-1)?.error).toBe("unknown error");
  });
});

/**
 * What a filtered transfer is allowed to swallow.
 *
 * `runSubagentWithPii` re-emits a child's chunks after restoring the masked
 * values, and it decides what to re-emit by listing the axes a chunk can carry
 * on its own. A chunk carrying only an axis nobody listed is dropped, and
 * nothing says so: the run finishes, the prose describes a report, and the
 * report is not there. Turning the filter off makes the same run work, which is
 * the shape that makes it hard to see.
 */
