import { describe, expect, it, vi } from "vitest";
import type { EngineChunk } from "@/domain/llm/types";
import { runAgent, type AgentDeps, type RunAgentInput } from "@/application/llm/engine";
import {
  contentChunk,
  FakeChannel,
  mergedDeltaChunk,
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
      return "sunny";
    });
    const deps: AgentDeps = {
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

  it("labels a Skill load's toolResult with the loaded skill name", async () => {
    const channel = new FakeChannel([
      [toolCallChunk(0, "call_1", "Skill", '{"skill_name":"image-generation"}'), usageChunk(10, 5)],
      [contentChunk("Loaded."), usageChunk(8, 4)],
    ]);
    const deps: AgentDeps = {
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
    const callMcpTool = vi.fn(async () => "sunny");
    const deps: AgentDeps = { channel, recordUsage: async () => {}, callMcpTool };

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
    const text = chunks
      .filter((c) => c.delta?.content)
      .map((c) => c.delta?.content)
      .join("");
    expect(text).toBe("Let me check. It is sunny.");
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
    const callMcpTool = vi.fn(async () => "results");
    const deps: AgentDeps = { channel, recordUsage: async () => {}, callMcpTool };

    const chunks = await collect(
      runAgent(deps, {
        projectName: "p",
        model: MODEL,
        messages: [{ role: "user", content: "search" }],
        mcpTools: [{ type: "function", function: { name: "search", parameters: {} } }],
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
    const deps: AgentDeps = {
      channel,
      recordUsage: async (r) => {
        recorded.push(r);
      },
      callMcpTool: async () => "ok",
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
  });

  it("rejects a transfer when fewer than two turns remain", async () => {
    const channel = new FakeChannel([
      [toolCallChunk(0, "call_t", "transfer_to_agent", '{"agent_name":"child","message":"hi"}'), usageChunk(1, 1)],
      [contentChunk("done"), usageChunk(1, 1)],
    ]);
    const runSubagent = vi.fn(async function* () {
      return "child-answer";
    });
    const deps: AgentDeps = {
      channel,
      recordUsage: async () => {},
      runSubagent,
    };
    const input: RunAgentInput = {
      projectName: "parent",
      model: MODEL,
      messages: [{ role: "user", content: "delegate" }],
      maxTurn: 2, // turn 0: turn+2 (2) >= maxTurn (2) -> reject
      subagents: [{ name: "child", description: "a child agent", type: "local" }],
    };

    const chunks = await collect(runAgent(deps, input));

    expect(runSubagent).not.toHaveBeenCalled();
    const rejection = chunks.find((c) => c.toolResult?.name === "transfer_to_agent");
    expect(rejection?.toolResult?.content).toContain("max_turn reached");
  });

  it("keeps top-level chunks unauthored when subagents are wired", async () => {
    const channel = new FakeChannel([
      [toolCallChunk(0, "call_t", "transfer_to_agent", '{"agent_name":"child","message":"hi"}'), usageChunk(1, 1)],
      [contentChunk("parent answer"), usageChunk(1, 1)],
    ]);
    const runSubagent = vi.fn(async function* (): AsyncGenerator<EngineChunk, string> {
      yield { author: "child", delta: { content: "child says hi" } };
      return "child says hi";
    });
    const deps: AgentDeps = {
      channel,
      recordUsage: async () => {},
      runSubagent,
    };
    const input: RunAgentInput = {
      projectName: "parent",
      model: MODEL,
      messages: [{ role: "user", content: "delegate" }],
      subagents: [{ name: "child", description: "a child agent", type: "local" }],
    };

    const chunks = await collect(runAgent(deps, input));

    // Only subagent chunks carry an author; the parent's own chunks never do,
    // so `!chunk.author` is the universal top-level predicate.
    const authored = chunks.filter((c) => c.author !== undefined);
    expect(authored.length).toBeGreaterThan(0);
    expect(authored.every((c) => c.author === "child")).toBe(true);
    const topContent = chunks
      .filter((c) => c.author === undefined && c.delta?.content)
      .map((c) => c.delta?.content)
      .join("");
    expect(topContent).toContain("parent answer");
  });
});

describe("tools + reasoning_effort provider constraint", () => {
  const TOOL = { type: "function" as const, function: { name: "lookup", parameters: {} } };

  it("forces reasoning_effort to 'none' for models that reject the combination", async () => {
    const channel = new FakeChannel([[contentChunk("ok"), usageChunk(1, 1)]]);
    const deps: AgentDeps = { channel, recordUsage: async () => {} };

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
    const deps: AgentDeps = { channel, recordUsage: async () => {} };

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
    const deps: AgentDeps = { channel, recordUsage: async () => {} };

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
    const deps: AgentDeps = { channel, recordUsage: async () => {} };

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

describe("runAgent GenerateImage builtin", () => {
  it("generates an image, yields an image chunk, and continues the loop", async () => {
    const { FakeChannel: FC } = await import("./fakeChannel");
    const channel = new FC([
      [toolCallChunk(0, "call_img", "GenerateImage", '{"prompt":"a red fox","size":"1024x1024"}'), usageChunk(10, 5)],
      [contentChunk("Here is your fox."), usageChunk(8, 4)],
    ]);
    const generateImage = vi.fn(async (prompt: string) => {
      expect(prompt).toBe("a red fox");
      return { b64: "aW1n", mimeType: "image/png" };
    });
    const deps: AgentDeps = { channel, generateImage };
    const chunks = await collect(
      runAgent(deps, {
        projectName: "artist",
        model: MODEL,
        messages: [{ role: "user", content: "draw a fox" }],
      }),
    );
    const imageChunk = chunks.find((c) => c.image);
    expect(imageChunk?.image).toMatchObject({ b64: "aW1n", mimeType: "image/png", prompt: "a red fox" });
    const finalText = chunks.map((c) => c.delta?.content ?? "").join("");
    expect(finalText).toContain("Here is your fox.");
    // the image tool is offered because generateImage is wired
    expect(channel.seenParams[0]?.tools?.some((t) => t.function.name === "GenerateImage")).toBe(true);
  });

  it("does not offer the tool when generateImage is absent", async () => {
    const { FakeChannel: FC } = await import("./fakeChannel");
    const channel = new FC([[contentChunk("hi"), usageChunk(1, 1)]]);
    await collect(
      runAgent({ channel }, { projectName: "p", model: MODEL, messages: [{ role: "user", content: "hi" }] }),
    );
    expect(channel.seenParams[0]?.tools?.some((t) => t.function.name === "GenerateImage") ?? false).toBe(false);
  });
});

describe("runAgent MCP server system prompt", () => {
  it("appends a Connected MCP Servers table when mcpServers are provided", async () => {
    const channel = new FakeChannel([[contentChunk("ok"), usageChunk(1, 1)]]);
    await collect(
      runAgent(
        { channel },
        {
          projectName: "p",
          model: MODEL,
          systemPrompt: "base prompt",
          messages: [{ role: "user", content: "hi" }],
          mcpTools: [{ type: "function", function: { name: "search_repos", parameters: {} } }],
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
        { channel },
        {
          projectName: "p",
          model: MODEL,
          systemPrompt: "base prompt",
          messages: [{ role: "user", content: "hi" }],
          mcpTools: [{ type: "function", function: { name: "search_repos", parameters: {} } }],
        },
      ),
    );
    const content = String(channel.seenParams[0]?.messages[0]?.content);
    expect(content).not.toContain("Connected MCP Servers");
  });
});
