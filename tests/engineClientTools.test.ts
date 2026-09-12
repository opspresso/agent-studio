import { describe, expect, it, vi } from "vitest";
import type { ChannelToolDef } from "@/domain/llm/channel";
import type { EngineChunk } from "@/domain/llm/types";
import { runTermination } from "@/domain/llm/types";
import {
  assembleAgentRun,
  buildAgentTools,
  IMAGE_TOOL_NAME,
  runAgent,
  type AgentDeps,
  type RunAgentInput,
} from "@/application/runtime";
import { contentChunk, FakeChannel, finishReasonChunk, toolCallChunk, usageChunk } from "./fakeChannel";

async function collect(gen: AsyncGenerator<EngineChunk>): Promise<EngineChunk[]> {
  const chunks: EngineChunk[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

const MODEL = "google/gemini-2.5-flash";

function clientTool(name: string): ChannelToolDef {
  return {
    type: "function",
    function: { name, description: `${name} on the client`, parameters: { type: "object", properties: {} } },
  };
}

const MCP_TOOL: ChannelToolDef = {
  type: "function",
  function: { name: "getWeather", description: "", parameters: {} },
};

function input(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    projectName: "app-bot",
    model: MODEL,
    systemPrompt: "You are helpful.",
    messages: [{ role: "user", content: "show the map" }],
    mcpTools: [MCP_TOOL],
    clientTools: [clientTool("showMap")],
    ...overrides,
  };
}

describe("client tools in the tool loop", () => {
  it("announces a client tool's call, dispatches nothing for it, and ends the run", async () => {
    const channel = new FakeChannel([
      [toolCallChunk(0, "call_1", "showMap", '{"city":"Seoul"}'), usageChunk(10, 5)],
      // A second turn would be the bug: the application holds the turn now.
      [contentChunk("never reached")],
    ]);
    const callMcpTool = vi.fn(async () => ({ text: "unexpected" }));
    const deps: AgentDeps = { channel, recordUsage: async () => {}, callMcpTool };

    const chunks = await collect(runAgent(deps, input()));

    expect(callMcpTool).not.toHaveBeenCalled();
    expect(channel.calls).toBe(1);
    const announced = chunks.find((c) => c.delta?.toolCalls);
    expect(announced?.delta?.toolCalls?.[0]).toMatchObject({
      id: "call_1",
      function: { name: "showMap", arguments: '{"city":"Seoul"}' },
    });
    expect(chunks.some((c) => c.toolResult)).toBe(false);
    expect(runTermination(chunks.at(-1)!)).toBe("completed");
  });

  it("still runs and reports the run's own calls in the turn that called a client tool", async () => {
    const channel = new FakeChannel([
      [
        toolCallChunk(0, "call_1", "getWeather", '{"city":"Seoul"}'),
        toolCallChunk(1, "call_2", "showMap", "{}"),
        usageChunk(10, 5),
      ],
      [contentChunk("never reached")],
    ]);
    const callMcpTool = vi.fn(async (name: string) => ({ text: `${name}: sunny` }));
    const deps: AgentDeps = { channel, recordUsage: async () => {}, callMcpTool };

    const chunks = await collect(runAgent(deps, input()));

    expect(callMcpTool).toHaveBeenCalledTimes(1);
    expect(callMcpTool).toHaveBeenCalledWith("getWeather", { city: "Seoul" });
    const results = chunks.filter((c) => c.toolResult).map((c) => c.toolResult!.toolCallId);
    expect(results).toEqual(["call_1"]);
    expect(channel.calls).toBe(1);
    expect(runTermination(chunks.at(-1)!)).toBe("completed");
  });

  it("answers a client tool's result from the history on the next run", async () => {
    const channel = new FakeChannel([[contentChunk("The map is up."), usageChunk(8, 4)]]);
    const deps: AgentDeps = { channel, recordUsage: async () => {} };
    const chunks = await collect(
      runAgent(
        deps,
        input({
          messages: [
            { role: "user", content: "show the map" },
            {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "call_1", type: "function", function: { name: "showMap", arguments: "{}" } }],
            },
            { role: "tool", content: "shown", tool_call_id: "call_1" },
          ],
        }),
      ),
    );
    expect(chunks.find((c) => c.delta?.content)?.delta?.content).toBe("The map is up.");
    const sent = channel.seenParams[0]!.messages;
    expect(sent.at(-1)).toMatchObject({ role: "tool", content: "shown", tool_call_id: "call_1" });
  });

  it("is never offered to a run that lacks the tool loop's deps for it, but is offered as a function", async () => {
    const channel = new FakeChannel([[contentChunk("ok")]]);
    const deps: AgentDeps = { channel, recordUsage: async () => {} };
    await collect(runAgent(deps, input()));
    const offered = channel.seenParams[0]!.tools?.map((tool) => tool.function.name);
    expect(offered).toEqual(["getWeather", "showMap"]);
  });
});

describe("client tools in the assembly", () => {
  const base = {
    skills: [],
    subagents: [],
    canLoadSkills: false,
    withImageTool: true,
    withEditTool: false,
    withImageTransfer: false,
    withUrlTool: false,
    withSaveFileTool: false,
    withSlackTools: false,
  };

  it("does not offer a client tool whose name the run already holds, and says so", () => {
    const offered = buildAgentTools({
      ...base,
      mcpTools: [MCP_TOOL],
      clientTools: [clientTool("getWeather"), clientTool(IMAGE_TOOL_NAME), clientTool("showMap"), clientTool("showMap")],
    });
    expect([...offered.clientToolNames]).toEqual(["showMap"]);
    expect(offered.tools.map((tool) => tool.function.name)).toEqual(["getWeather", IMAGE_TOOL_NAME, "showMap"]);
    expect(offered.warnings).toEqual([
      `Application tool(s) not offered because the run already has a tool by that name: getWeather, ${IMAGE_TOOL_NAME}, showMap.`,
    ]);
  });

  it("cuts client tools to the request's room and reports the count", () => {
    const many = Array.from({ length: 130 }, (_, i) => clientTool(`t${i}`));
    const offered = buildAgentTools({ ...base, clientTools: many });
    // One builtin (GenerateImage) is on the list already.
    expect(offered.tools).toHaveLength(128);
    expect(offered.clientToolNames.size).toBe(127);
    expect(offered.warnings).toEqual([
      "3 application tool(s) were not offered: a request may declare at most 128 tools in all.",
    ]);
  });

  it("describes the offered client tools in the prompt, and only those", () => {
    const assembly = assembleAgentRun(
      {},
      { systemPrompt: "Base.", mcpTools: [MCP_TOOL], clientTools: [clientTool("showMap"), clientTool("getWeather")] },
    );
    expect(assembly.systemPrompt).toContain("## Application Tools");
    expect(assembly.systemPrompt).toContain("| showMap | showMap on the client |");
    expect(assembly.systemPrompt).not.toContain("| getWeather | getWeather on the client |");
    expect(assembly.systemPrompt).toContain("call an application tool when");
    expect(assembly.warnings).toHaveLength(1);
  });

  it("reports what it could not offer before the first turn", async () => {
    const channel = new FakeChannel([[contentChunk("ok")]]);
    const deps: AgentDeps = { channel, recordUsage: async () => {} };
    const chunks = await collect(runAgent(deps, input({ clientTools: [clientTool("getWeather")] })));
    expect(chunks[0]?.warning).toContain("getWeather");
  });
});

describe("a turn that ends on a client tool", () => {
  it("announces a client tool's arguments whole, however large", async () => {
    // The announced copy is the call: nothing else carries it to the application.
    const content = "x".repeat(20 * 1024);
    const channel = new FakeChannel([
      [toolCallChunk(0, "call_1", "insertDocument", JSON.stringify({ content })), usageChunk(10, 5)],
    ]);
    const deps: AgentDeps = { channel, recordUsage: async () => {} };
    const chunks = await collect(runAgent(deps, input({ clientTools: [clientTool("insertDocument")] })));
    const announced = chunks.find((c) => c.delta?.toolCalls)?.delta?.toolCalls?.[0];
    expect(JSON.parse(announced?.function?.arguments ?? "{}")).toEqual({ content });
    expect(announced?.function?.arguments).not.toContain("elided");
  });

  it("lets the SDK report malformed client-tool input and recover after an output cut", async () => {
    const channel = new FakeChannel([
      [toolCallChunk(0, "call_1", "showMap", '{"city":"Se'), finishReasonChunk("length"), usageChunk(10, 5)],
      [contentChunk("recovered")],
    ]);
    const deps: AgentDeps = { channel, recordUsage: async () => {} };
    const chunks = await collect(runAgent(deps, input()));
    expect(channel.calls).toBe(2);
    expect(chunks.find((c) => c.warning)?.warning).toContain("output limit");
    expect(chunks.find((c) => c.toolResult)?.toolResult?.content).toContain("parsing tool arguments");
    expect(runTermination(chunks.at(-1)!)).toBe("completed");
    // Announced as the model wrote it, parsed or not.
    expect(chunks.find((c) => c.delta?.toolCalls)?.delta?.toolCalls?.[0]?.function?.arguments).toBe('{"city":"Se');
  });



  it("warns that a picture a tool returned this turn will not reach the model again", async () => {
    const channel = new FakeChannel([
      [
        toolCallChunk(0, "c1", "screenshot", "{}"),
        toolCallChunk(1, "c2", "showMap", "{}"),
        usageChunk(10, 5),
      ],
      [contentChunk("never reached")],
    ]);
    const callMcpTool = vi.fn(async () => ({ text: "shot", images: [{ b64: "AAAA", mimeType: "image/png" }] }));
    const deps: AgentDeps = { channel, recordUsage: async () => {}, callMcpTool };
    const chunks = await collect(
      runAgent(
        deps,
        input({
          mcpTools: [{ type: "function", function: { name: "screenshot", description: "", parameters: {} } }],
        }),
      ),
    );
    expect(chunks.some((c) => c.image)).toBe(true);
    expect(chunks.map((c) => c.warning).filter(Boolean)).toEqual([
      "1 image(s) tools returned this turn were delivered, but the model will not see them on the next run: the run ends here for the application to act.",
    ]);
  });
});
