import { createToolSchemaValidator } from "@/infrastructure/llm/toolSchema";
import { describe, expect, it, vi } from "vitest";
import type { EngineChunk } from "@/domain/llm/types";
import type { ChannelMessage, ChannelToolCall } from "@/domain/llm/channel";
import { runAgent, type AgentDeps, type RunAgentInput } from "@/application/runtime";
import {
  contentChunk,
  FakeChannel,
  toolCallArgsChunk,
  toolCallChunk,
  toolCallChunkWithoutId,
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
  it("continues valid sibling tools when the SDK rejects an earlier malformed call", async () => {
    const channel = new FakeChannel([
      [toolCallChunk(0, "invalid", "lookup", '{"query": broken'), toolCallChunk(1, "valid", "lookup", '{"query":"Seoul"}'), usageChunk(10, 5)],
      [contentChunk("recovered"), usageChunk(8, 4)],
    ]);
    const callMcpTool = vi.fn(async () => ({ text: "found" }));
    const chunks = await collect(runAgent({ createToolSchemaValidator, channel, callMcpTool }, {
      agentName: "p", model: MODEL, messages: [{ role: "user", content: "lookup" }],
      mcpTools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
    }));
    expect(callMcpTool).toHaveBeenCalledExactlyOnceWith("lookup", { query: "Seoul" });
    expect(chunks.filter((chunk) => chunk.error)).toEqual([]);
    expect(chunks.find((chunk) => chunk.toolResult?.toolCallId === "invalid")?.toolResult?.content).toContain("parsing tool arguments");
    expect(chunks.find((chunk) => chunk.toolResult?.toolCallId === "valid")?.toolResult?.content).toBe("found");
    expect(toolMsgIdsOf(followUpMessages(channel))).toEqual(["invalid", "valid"]);
    expect(channel.calls).toBe(2);
  });

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
    const deps: AgentDeps = { createToolSchemaValidator, channel, recordUsage: async () => {}, callMcpTool };
    const input: RunAgentInput = {
      agentName: "p",
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


});

describe("ToolCallAccumulator makes every call of a response addressable", () => {
  it("gives calls the provider left without an id distinct ids, so neither reads the other's result", async () => {
    const channel = new FakeChannel([
      [
        toolCallChunkWithoutId(0, "getWeather", '{"city":"Seoul"}'),
        toolCallChunkWithoutId(1, "getTime", '{"tz":"KST"}'),
        usageChunk(10, 5),
      ],
      [contentChunk("done"), usageChunk(8, 4)],
    ]);
    const callMcpTool = vi.fn(async (name: string) => ({
      text: name === "getWeather" ? "sunny" : "09:00",
    }));
    const deps: AgentDeps = { createToolSchemaValidator, channel, recordUsage: async () => {}, callMcpTool };

    const chunks = await collect(
      runAgent(deps, {
        agentName: "p",
        model: MODEL,
        messages: [{ role: "user", content: "weather and time?" }],
        mcpTools: [
          { type: "function", function: { name: "getWeather", parameters: {} } },
          { type: "function", function: { name: "getTime", parameters: {} } },
        ],
      }),
    );

    // Each call carries its OWN result — a shared id would cross them over.
    expect(chunks.filter((c) => c.toolResult).map((c) => c.toolResult?.content)).toEqual([
      "sunny",
      "09:00",
    ]);

    const messages = followUpMessages(channel);
    const ids = idsOf(assistantWithToolCalls(messages)?.tool_calls);
    expect(ids).toHaveLength(2);
    expect(ids.every((id) => typeof id === "string" && id !== "")).toBe(true);
    expect(new Set(ids).size).toBe(2);
    // The tool messages pair with those ids, in order and with no duplicates.
    expect(toolMsgIdsOf(messages)).toEqual(ids);
  });

  it("keeps a provider's own ids when it supplies them", async () => {
    const channel = new FakeChannel([
      [
        toolCallChunk(0, "call_a", "getWeather", "{}"),
        toolCallChunkWithoutId(1, "getTime", "{}"),
        usageChunk(10, 5),
      ],
      [contentChunk("done"), usageChunk(8, 4)],
    ]);
    const deps: AgentDeps = { createToolSchemaValidator,
      channel,
      recordUsage: async () => {},
      callMcpTool: vi.fn(async () => ({ text: "ok" })),
    };

    await collect(
      runAgent(deps, {
        agentName: "p",
        model: MODEL,
        messages: [{ role: "user", content: "both" }],
        mcpTools: [
          { type: "function", function: { name: "getWeather", parameters: {} } },
          { type: "function", function: { name: "getTime", parameters: {} } },
        ],
      }),
    );

    const ids = idsOf(assistantWithToolCalls(followUpMessages(channel))?.tool_calls);
    expect(ids[0]).toBe("call_a");
    expect(ids[1]).toBeTruthy();
    expect(ids[1]).not.toBe("call_a");
  });

  it("keeps synthesized ids distinct across the run's turns", async () => {
    // A chat persists ONE assistant message carrying every turn's calls. Ids
    // that only had to be unique per response would collide there, and the
    // next request would carry duplicate tool_call_ids.
    const channel = new FakeChannel([
      [toolCallChunkWithoutId(0, "getTime", "{}"), usageChunk(10, 5)],
      [toolCallChunkWithoutId(0, "getTime", "{}"), usageChunk(10, 5)],
      [contentChunk("done"), usageChunk(8, 4)],
    ]);
    const deps: AgentDeps = { createToolSchemaValidator,
      channel,
      recordUsage: async () => {},
      callMcpTool: vi.fn(async () => ({ text: "ok" })),
    };

    const chunks = await collect(
      runAgent(deps, {
        agentName: "p",
        model: MODEL,
        messages: [{ role: "user", content: "twice" }],
        mcpTools: [{ type: "function", function: { name: "getTime", parameters: {} } }],
      }),
    );

    const announced = chunks.flatMap((c) => c.delta?.toolCalls ?? []).map((c) => c.id);
    expect(announced).toHaveLength(2);
    expect(new Set(announced).size).toBe(2);
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
    const deps: AgentDeps = { createToolSchemaValidator, channel, recordUsage: async () => {}, callMcpTool };

    await collect(
      runAgent(deps, {
        agentName: "p",
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
    const deps: AgentDeps = { createToolSchemaValidator, channel, recordUsage: async () => {}, callMcpTool };

    const chunks = await collect(
      runAgent(deps, {
        agentName: "p",
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
    const deps: AgentDeps = { createToolSchemaValidator,
      channel,
      recordUsage: async () => {},
      callMcpTool: async () => ({ text: "captured", images: [{ b64: PIXEL, mimeType: "image/png" }] }),
    };

    const chunks = await collect(
      runAgent(deps, {
        agentName: "p",
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

  it("delivers a picture the model cannot read, and says so", async () => {
    // Sending image parts to a text-only model fails the whole turn — but the
    // person who asked for the screenshot is not the model. Losing both at once
    // meant the picture was never streamed, never stored and never part of the
    // finished conversation; `EngineChunk.file` already draws the line in the
    // right place.
    const channel = screenshotChannel();
    const deps: AgentDeps = { createToolSchemaValidator,
      channel,
      recordUsage: async () => {},
      callMcpTool: async () => ({ text: "captured", images: [{ b64: PIXEL, mimeType: "image/png" }] }),
    };

    const chunks = await collect(
      runAgent(deps, {
        agentName: "p",
        model: "openai/gpt-5-mini-text-only-not-in-catalog",
        messages: [{ role: "user", content: "what is on screen?" }],
        mcpTools: screenshotTools,
      }),
    );

    expect(chunks.filter((c) => c.image).map((c) => c.image?.b64)).toEqual([PIXEL]);
    const toolResult = chunks.find((c) => c.toolResult)?.toolResult?.content ?? "";
    expect(toolResult).toContain("delivered to the user");
    expect(toolResult).toContain("but not to you");
    // The context is what the model's capability decides, and it stays empty.
    const hasImagePart = followUpMessages(channel).some(
      (m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"),
    );
    expect(hasImagePart).toBe(false);
  });



  it("caps how many pictures one turn may take in", async () => {
    const channel = screenshotChannel();
    const many = Array.from({ length: 9 }, () => ({ b64: PIXEL, mimeType: "image/png" }));
    const deps: AgentDeps = { createToolSchemaValidator,
      channel,
      recordUsage: async () => {},
      callMcpTool: async () => ({ text: "captured", images: many }),
    };

    const chunks = await collect(
      runAgent(deps, {
        agentName: "p",
        model: MODEL,
        messages: [{ role: "user", content: "capture everything" }],
        mcpTools: screenshotTools,
      }),
    );

    expect(chunks.filter((c) => c.image)).toHaveLength(4);
    // The overflow is stated, not silently swallowed.
    expect(chunks.find((c) => c.toolResult)?.toolResult?.content).toContain("dropped");
  });

  it("gives every turn its own budget, as the result text promises", async () => {
    // The cap exists to bound ONE turn's context. Spending it across the whole
    // run would leave a screenshot agent blind from its second turn on, while
    // the result text kept telling the model the limit was per turn.
    const channel = new FakeChannel([
      [toolCallChunk(0, "call_1", "screenshot", "{}"), usageChunk(10, 5)],
      [toolCallChunk(0, "call_2", "screenshot", "{}"), usageChunk(10, 5)],
      [contentChunk("both pages look fine."), usageChunk(8, 4)],
    ]);
    const four = Array.from({ length: 4 }, () => ({ b64: PIXEL, mimeType: "image/png" }));
    const deps: AgentDeps = { createToolSchemaValidator,
      channel,
      recordUsage: async () => {},
      callMcpTool: async () => ({ text: "captured", images: four }),
    };

    const chunks = await collect(
      runAgent(deps, {
        agentName: "p",
        model: MODEL,
        messages: [{ role: "user", content: "check both pages" }],
        mcpTools: screenshotTools,
      }),
    );

    expect(chunks.filter((c) => c.image)).toHaveLength(8);
    expect(chunks.filter((c) => c.toolResult?.content.includes("dropped"))).toHaveLength(0);
  });

  it("does not claim images are attached when none were", async () => {
    const channel = screenshotChannel();
    const many = Array.from({ length: 6 }, () => ({ b64: PIXEL, mimeType: "image/png" }));
    const deps: AgentDeps = { createToolSchemaValidator,
      channel,
      recordUsage: async () => {},
      // Two calls in one response: the second finds the turn's budget spent.
      callMcpTool: async () => ({ text: "captured", images: many }),
    };

    const chunks = await collect(
      runAgent(deps, {
        agentName: "p",
        model: MODEL,
        messages: [{ role: "user", content: "capture" }],
        mcpTools: screenshotTools,
      }),
    );

    const toolResult = chunks.find((c) => c.toolResult)?.toolResult?.content ?? "";
    expect(toolResult).toContain("4 image(s)");
    expect(toolResult).toContain("2 more were dropped");
    expect(toolResult).not.toContain("0 image(s)");
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
    const deps: AgentDeps = { createToolSchemaValidator, channel, recordUsage: async () => {}, callMcpTool };

    const chunks = await collect(
      runAgent(deps, {
        agentName: "p",
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
