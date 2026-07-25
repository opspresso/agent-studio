import { describe, expect, it, vi } from "vitest";
import type { EngineChunk } from "@/domain/llm/types";
import type { ChannelMessage, ChannelToolCall } from "@/domain/llm/channel";
import { runAgent, type AgentDeps, type RunAgentInput } from "@/application/llm/engine";
import { contentChunk, FakeChannel, toolCallArgsChunk, toolCallChunk, usageChunk } from "./fakeChannel";

async function collect(gen: AsyncGenerator<EngineChunk>): Promise<EngineChunk[]> {
  const chunks: EngineChunk[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

const MODEL = "google/gemini-2.5-flash";

/** The message list the channel saw on the follow-up turn (after tool results). */
function followUpMessages(channel: FakeChannel): ChannelMessage[] {
  return channel.seenParams[1]?.messages ?? [];
}

function assistantWithToolCalls(messages: ChannelMessage[]): ChannelMessage | undefined {
  return messages.find((m) => m.role === "assistant" && (m.tool_calls?.length ?? 0) > 0);
}

const idsOf = (calls: ChannelToolCall[] | undefined) => (calls ?? []).map((c) => c.id);
const toolMsgIdsOf = (messages: ChannelMessage[]) =>
  messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id);

describe("runAgent aggregates multiple tool calls from one response", () => {
  it("emits ONE assistant message carrying every call, then one tool message per call, in order, with no orphans", async () => {
    const channel = new FakeChannel([
      [
        toolCallChunk(0, "call_a", "getWeather", '{"city":"Seoul"}'),
        toolCallChunk(1, "call_b", "getTime", '{"tz":"KST"}'),
        usageChunk(10, 5),
      ],
      [contentChunk("done"), usageChunk(8, 4)],
    ]);
    const calledOrder: string[] = [];
    const callMcpTool = vi.fn(async (name: string) => {
      calledOrder.push(name);
      return { text: name === "getWeather" ? "sunny" : "09:00" };
    });
    const deps: AgentDeps = { channel, recordUsage: async () => {}, callMcpTool };
    const input: RunAgentInput = {
      projectName: "p",
      model: MODEL,
      systemPrompt: "s",
      messages: [{ role: "user", content: "weather and time?" }],
      mcpTools: [
        { type: "function", function: { name: "getWeather", parameters: {} } },
        { type: "function", function: { name: "getTime", parameters: {} } },
      ],
    };

    const chunks = await collect(runAgent(deps, input));

    // Both tools ran, in call order.
    expect(calledOrder).toEqual(["getWeather", "getTime"]);
    // Both results streamed to the client.
    const resultIds = chunks.filter((c) => c.toolResult).map((c) => c.toolResult?.toolCallId);
    expect(resultIds).toEqual(["call_a", "call_b"]);

    const messages = followUpMessages(channel);
    const assistant = assistantWithToolCalls(messages);
    // ONE assistant message carries BOTH calls.
    expect(assistant).toBeDefined();
    expect(idsOf(assistant?.tool_calls)).toEqual(["call_a", "call_b"]);
    expect(messages.filter((m) => m.role === "assistant")).toHaveLength(1);

    // Every requested call has a matching tool message, same order, no orphan
    // either direction — the exact shape a real provider validates.
    expect(toolMsgIdsOf(messages)).toEqual(["call_a", "call_b"]);
    expect(new Set(toolMsgIdsOf(messages))).toEqual(new Set(idsOf(assistant?.tool_calls)));
  });

  it("interleaves a subagent transfer with an MCP call: tool messages first (in order), context user message last", async () => {
    const channel = new FakeChannel([
      [
        toolCallChunk(0, "call_t", "transfer_to_agent", '{"agent_name":"child","message":"hi"}'),
        toolCallChunk(1, "call_m", "getWeather", '{"city":"Seoul"}'),
        usageChunk(10, 5),
      ],
      [contentChunk("done"), usageChunk(8, 4)],
    ]);
    const runSubagent = vi.fn(async function* (): AsyncGenerator<EngineChunk, string> {
      yield { author: "child", delta: { content: "child says hi" } };
      return "child-answer";
    });
    const callMcpTool = vi.fn(async () => ({ text: "sunny" }));
    const deps: AgentDeps = { channel, recordUsage: async () => {}, runSubagent, callMcpTool };
    const input: RunAgentInput = {
      projectName: "parent",
      model: MODEL,
      messages: [{ role: "user", content: "delegate and fetch" }],
      subagents: [{ name: "child", description: "a child agent", type: "local" }],
      mcpTools: [{ type: "function", function: { name: "getWeather", parameters: {} } }],
    };

    const chunks = await collect(runAgent(deps, input));

    expect(runSubagent).toHaveBeenCalledTimes(1);
    expect(callMcpTool).toHaveBeenCalledTimes(1);

    const messages = followUpMessages(channel);
    const assistant = assistantWithToolCalls(messages);
    // Both calls hang off the single assistant message; both are answered.
    expect(idsOf(assistant?.tool_calls)).toEqual(["call_t", "call_m"]);
    expect(toolMsgIdsOf(messages)).toEqual(["call_t", "call_m"]);

    // The transfer's "For context" user message must come AFTER every tool
    // message — a tool message may never trail a non-tool message in the block.
    const assistantIdx = messages.indexOf(assistant as ChannelMessage);
    const block = messages.slice(assistantIdx + 1);
    const lastToolIdx = block.map((m) => m.role).lastIndexOf("tool");
    const contextIdx = block.findIndex(
      (m) => m.role === "user" && String(m.content).includes("child-answer"),
    );
    expect(contextIdx).toBeGreaterThan(lastToolIdx);
    // The transfer's own tool message is the null-result placeholder.
    const transferToolMsg = block.find((m) => m.role === "tool" && m.tool_call_id === "call_t");
    expect(String(transferToolMsg?.content)).toContain("null");
  });
});

describe("ToolCallAccumulator reassembles streamed fragments", () => {
  it("joins a call whose id/name arrive first and arguments span later fragments", async () => {
    const channel = new FakeChannel([
      [
        toolCallChunk(0, "call_1", "search", '{"que'),
        toolCallArgsChunk(0, 'ry":"c'),
        toolCallArgsChunk(0, 'ats"}'),
        usageChunk(10, 5),
      ],
      [contentChunk("found"), usageChunk(8, 4)],
    ]);
    const callMcpTool = vi.fn(async () => ({ text: "results" }));
    const deps: AgentDeps = { channel, recordUsage: async () => {}, callMcpTool };

    await collect(
      runAgent(deps, {
        projectName: "p",
        model: MODEL,
        messages: [{ role: "user", content: "search cats" }],
        mcpTools: [{ type: "function", function: { name: "search", parameters: {} } }],
      }),
    );

    // Name and the arguments concatenated across three fragments reassemble.
    expect(callMcpTool).toHaveBeenCalledTimes(1);
    expect(callMcpTool).toHaveBeenCalledWith("search", { query: "cats" });
  });
});

describe("MCP calls of one response overlap", () => {
  it("dispatches them concurrently while keeping results in call order", async () => {
    // The first call only finishes once the second has started: sequential
    // dispatch deadlocks here, concurrent dispatch completes.
    let releaseSlow: (() => void) | undefined;
    const slowBlocked = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const started: string[] = [];
    const callMcpTool = vi.fn(async (name: string) => {
      started.push(name);
      if (name === "slow") {
        await slowBlocked;
        return { text: "slow done" };
      }
      releaseSlow?.();
      return { text: "fast done" };
    });
    const channel = new FakeChannel([
      [
        toolCallChunk(0, "call_slow", "slow", "{}"),
        toolCallChunk(1, "call_fast", "fast", "{}"),
        usageChunk(10, 5),
      ],
      [contentChunk("both done"), usageChunk(8, 4)],
    ]);
    const deps: AgentDeps = { channel, recordUsage: async () => {}, callMcpTool };

    const chunks = await collect(
      runAgent(deps, {
        projectName: "p",
        model: MODEL,
        messages: [{ role: "user", content: "do both" }],
        mcpTools: [
          { type: "function", function: { name: "slow", parameters: {} } },
          { type: "function", function: { name: "fast", parameters: {} } },
        ],
      }),
    );

    expect(started).toEqual(["slow", "fast"]);
    // Results and tool messages still follow the assistant message's tool_calls.
    expect(chunks.filter((c) => c.toolResult).map((c) => c.toolResult?.content)).toEqual([
      "slow done",
      "fast done",
    ]);
    const messages = followUpMessages(channel);
    expect(toolMsgIdsOf(messages)).toEqual(["call_slow", "call_fast"]);
    expect(idsOf(assistantWithToolCalls(messages)?.tool_calls)).toEqual([
      "call_slow",
      "call_fast",
    ]);
  });
});

describe("images an MCP tool returns", () => {
  const PIXEL = "iVBORw0KGgo=";
  const screenshotTools = [{ type: "function" as const, function: { name: "screenshot", parameters: {} } }];

  function screenshotChannel(): FakeChannel {
    return new FakeChannel([
      [toolCallChunk(0, "call_1", "screenshot", "{}"), usageChunk(10, 5)],
      [contentChunk("I see a login form."), usageChunk(8, 4)],
    ]);
  }

  it("attaches the picture to the next turn and delivers it to the user", async () => {
    // A tool message is text-only, so bytes that stayed in the tool result would
    // never reach the model — the run would answer about a picture it never saw.
    const channel = screenshotChannel();
    const deps: AgentDeps = {
      channel,
      recordUsage: async () => {},
      callMcpTool: async () => ({ text: "captured", images: [{ b64: PIXEL, mimeType: "image/png" }] }),
    };

    const chunks = await collect(
      runAgent(deps, {
        projectName: "p",
        model: MODEL,
        messages: [{ role: "user", content: "what is on screen?" }],
        mcpTools: screenshotTools,
      }),
    );

    // The user sees it.
    expect(chunks.filter((c) => c.image).map((c) => c.image?.b64)).toEqual([PIXEL]);
    // The model sees it: a user turn carrying the bytes, after the tool message.
    const messages = followUpMessages(channel);
    const withImage = messages.find(
      (m) => m.role === "user" && Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"),
    );
    expect(withImage).toBeDefined();
    const lastToolIdx = messages.map((m) => m.role).lastIndexOf("tool");
    expect(messages.indexOf(withImage as ChannelMessage)).toBeGreaterThan(lastToolIdx);
    // And the tool result says the picture is coming, so the text is not a dead end.
    const toolResult = chunks.find((c) => c.toolResult)?.toolResult?.content ?? "";
    expect(toolResult).toContain("captured");
    expect(toolResult).toContain("attached");
  });

  it("tells the model the pictures were dropped when it cannot read images", async () => {
    // Sending image parts to a text-only model fails the whole turn.
    const channel = screenshotChannel();
    const deps: AgentDeps = {
      channel,
      recordUsage: async () => {},
      callMcpTool: async () => ({ text: "captured", images: [{ b64: PIXEL, mimeType: "image/png" }] }),
    };

    const chunks = await collect(
      runAgent(deps, {
        projectName: "p",
        model: "openai/gpt-5-mini-text-only-not-in-catalog",
        messages: [{ role: "user", content: "what is on screen?" }],
        mcpTools: screenshotTools,
      }),
    );

    expect(chunks.some((c) => c.image)).toBe(false);
    expect(chunks.find((c) => c.toolResult)?.toolResult?.content).toContain("dropped");
    const hasImagePart = followUpMessages(channel).some(
      (m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"),
    );
    expect(hasImagePart).toBe(false);
  });

  it("caps how many pictures one turn may take in", async () => {
    const channel = screenshotChannel();
    const many = Array.from({ length: 9 }, () => ({ b64: PIXEL, mimeType: "image/png" }));
    const deps: AgentDeps = {
      channel,
      recordUsage: async () => {},
      callMcpTool: async () => ({ text: "captured", images: many }),
    };

    const chunks = await collect(
      runAgent(deps, {
        projectName: "p",
        model: MODEL,
        messages: [{ role: "user", content: "capture everything" }],
        mcpTools: screenshotTools,
      }),
    );

    expect(chunks.filter((c) => c.image)).toHaveLength(4);
    // The overflow is stated, not silently swallowed.
    expect(chunks.find((c) => c.toolResult)?.toolResult?.content).toContain("dropped");
  });
});

describe("per-turn tool result budget", () => {
  it("truncates past the budget and omits what no longer fits", async () => {
    // Each result is capped on its own, but a turn full of them would blow the
    // context window. The cut is explicit so the model can narrow its next call.
    const big = "x".repeat(150_000);
    const callMcpTool = vi.fn(async () => ({ text: big }));
    const channel = new FakeChannel([
      [
        toolCallChunk(0, "call_1", "dump", "{}"),
        toolCallChunk(1, "call_2", "dump", "{}"),
        toolCallChunk(2, "call_3", "dump", "{}"),
        usageChunk(10, 5),
      ],
      [contentChunk("enough"), usageChunk(8, 4)],
    ]);
    const deps: AgentDeps = { channel, recordUsage: async () => {}, callMcpTool };

    const chunks = await collect(
      runAgent(deps, {
        projectName: "p",
        model: MODEL,
        messages: [{ role: "user", content: "dump everything" }],
        mcpTools: [{ type: "function", function: { name: "dump", parameters: {} } }],
      }),
    );

    const results = chunks.filter((c) => c.toolResult).map((c) => c.toolResult?.content ?? "");
    expect(results[0]).toBe(big);
    expect(results[1]?.startsWith("x".repeat(50_000))).toBe(true);
    expect(results[1]).toContain("truncated");
    // Nothing left: reported as an error so the trace shows a failed span.
    expect(results[2]?.startsWith("Error:")).toBe(true);
    expect(results[2]).toContain("budget is exhausted");
    // The context carries exactly what the model was shown.
    const toolContents = followUpMessages(channel)
      .filter((m) => m.role === "tool")
      .map((m) => String(m.content));
    expect(toolContents).toEqual(results);
  });
});
