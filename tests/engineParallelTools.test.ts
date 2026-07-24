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
      return name === "getWeather" ? "sunny" : "09:00";
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
    const callMcpTool = vi.fn(async () => "sunny");
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
    const callMcpTool = vi.fn(async () => "results");
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
