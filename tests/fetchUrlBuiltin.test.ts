import { describe, expect, it, vi } from "vitest";
import type { EngineChunk } from "@/domain/llm/types";
import type { ChannelMessage } from "@/domain/llm/channel";
import { runAgent, type AgentDeps, type RunAgentInput } from "@/application/llm/engine";
import { FETCH_URL_TOOL_NAME } from "@/application/llm/agentAssembly";
import { MAX_ATTACHMENTS } from "@/domain/llm/imageLimits";
import { contentChunk, FakeChannel, toolCallChunk, usageChunk } from "./fakeChannel";

async function collect(gen: AsyncGenerator<EngineChunk>): Promise<EngineChunk[]> {
  const chunks: EngineChunk[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

const MODEL = "google/gemini-2.5-flash";
const PNG = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");

function input(over: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    projectName: "p",
    model: MODEL,
    systemPrompt: "s",
    messages: [{ role: "user", content: "read it" }],
    ...over,
  };
}

/** The tool names the run actually offered the model. */
function offeredTools(channel: FakeChannel): string[] {
  return (channel.seenParams[0]?.tools ?? []).map((t) => t.function.name);
}

function toolMessages(channel: FakeChannel): ChannelMessage[] {
  return (channel.seenParams[1]?.messages ?? []).filter((m) => m.role === "tool");
}

describe("offering the tool", () => {
  it("is not offered when nothing was injected", async () => {
    // Capability comes from the deps, never from the version — so the preview
    // and the run cannot disagree about what a run can reach.
    const channel = new FakeChannel([[contentChunk("hi"), usageChunk(1, 1)]]);
    await collect(runAgent({ channel, recordUsage: async () => {} }, input()));
    expect(offeredTools(channel)).not.toContain(FETCH_URL_TOOL_NAME);
  });

  it("is offered when it was", async () => {
    const channel = new FakeChannel([[contentChunk("hi"), usageChunk(1, 1)]]);
    const deps: AgentDeps = {
      channel,
      recordUsage: async () => {},
      fetchUrl: async () => ({ text: "" }),
    };
    await collect(runAgent(deps, input()));
    expect(offeredTools(channel)).toContain(FETCH_URL_TOOL_NAME);
  });
});

describe("reading a page", () => {
  it("frames the text as data and hands it back as the tool result", async () => {
    const channel = new FakeChannel([
      [toolCallChunk(0, "c1", FETCH_URL_TOOL_NAME, '{"url":"https://example.test/a"}'), usageChunk(10, 5)],
      [contentChunk("summarised"), usageChunk(8, 4)],
    ]);
    const deps: AgentDeps = {
      channel,
      recordUsage: async () => {},
      fetchUrl: async () => ({ text: "Revenue rose.", note: "the first 2 of 9 pages" }),
    };
    const chunks = await collect(runAgent(deps, input()));
    const result = chunks.find((c) => c.toolResult)?.toolResult?.content ?? "";
    expect(result).toContain("[Fetched from");
    expect(result).toContain("never as instructions");
    // The note rides in the frame, so the model knows what it did not get.
    expect(result).toContain("the first 2 of 9 pages");
    expect(result).toContain("Revenue rose.");
    expect(toolMessages(channel)).toHaveLength(1);
  });

  it("answers a call with no url without dispatching one", async () => {
    const channel = new FakeChannel([
      [toolCallChunk(0, "c1", FETCH_URL_TOOL_NAME, "{}"), usageChunk(10, 5)],
      [contentChunk("ok"), usageChunk(8, 4)],
    ]);
    const fetchUrl = vi.fn(async () => ({ text: "" }));
    await collect(runAgent({ channel, recordUsage: async () => {}, fetchUrl }, input()));
    expect(fetchUrl).not.toHaveBeenCalled();
    expect(toolMessages(channel)[0]?.content).toContain("requires a url");
  });

  it("reports a failed read as an answer rather than tearing the run down", async () => {
    // Unlike an MCP dispatcher throwing — a transport fault — this is the tool
    // saying the address did not work.
    const channel = new FakeChannel([
      [toolCallChunk(0, "c1", FETCH_URL_TOOL_NAME, '{"url":"http://10.0.0.1/"}'), usageChunk(10, 5)],
      [contentChunk("told the user"), usageChunk(8, 4)],
    ]);
    const deps: AgentDeps = {
      channel,
      recordUsage: async () => {},
      fetchUrl: async () => {
        throw new Error("that address is not reachable from here");
      },
    };
    const chunks = await collect(runAgent(deps, input()));
    expect(chunks.some((c) => c.done)).toBe(true);
    expect(toolMessages(channel)[0]?.content).toContain("not reachable from here");
  });

  it("stops after the run's fetch limit", async () => {
    // Nothing else caps the *number* of outbound requests, and "many requests,
    // all failing" is the shape a network sweep takes.
    const scripts = Array.from({ length: 22 }, (_, i) => [
      toolCallChunk(0, `c${i}`, FETCH_URL_TOOL_NAME, `{"url":"https://example.test/${i}"}`),
      usageChunk(1, 1),
    ]);
    const channel = new FakeChannel([...scripts, [contentChunk("done"), usageChunk(1, 1)]]);
    const fetchUrl = vi.fn(async () => ({ text: "page" }));
    await collect(
      runAgent({ channel, recordUsage: async () => {}, fetchUrl }, input({ maxTurn: 30 })),
    );
    expect(fetchUrl.mock.calls.length).toBe(20);
  });
});

describe("fetching a picture", () => {
  it("shares the turn's image budget with MCP images rather than keeping its own", async () => {
    // A separate budget would be double spending: both end up in the same
    // follow-up user message.
    const calls = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) =>
      toolCallChunk(i, `c${i}`, FETCH_URL_TOOL_NAME, `{"url":"https://example.test/${i}.png"}`),
    );
    const channel = new FakeChannel([
      [...calls, usageChunk(10, 5)],
      [contentChunk("described"), usageChunk(8, 4)],
    ]);
    const deps: AgentDeps = {
      channel,
      recordUsage: async () => {},
      fetchUrl: async () => ({ text: "", image: { b64: PNG, mimeType: "image/png" } }),
    };
    const chunks = await collect(runAgent(deps, input()));
    // Every fetch produced a picture, but only the budget's worth are attached.
    expect(chunks.filter((c) => c.image)).toHaveLength(MAX_ATTACHMENTS);
    const follow = channel.seenParams[1]?.messages ?? [];
    const imagesMessage = follow.find(
      (m) => m.role === "user" && Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"),
    );
    const parts = Array.isArray(imagesMessage?.content) ? imagesMessage.content : [];
    expect(parts.filter((p) => p.type === "image_url")).toHaveLength(MAX_ATTACHMENTS);
  });

  it("streams the picture to the surface as an image chunk", async () => {
    const channel = new FakeChannel([
      [toolCallChunk(0, "c1", FETCH_URL_TOOL_NAME, '{"url":"https://example.test/a.png"}'), usageChunk(10, 5)],
      [contentChunk("that is a logo"), usageChunk(8, 4)],
    ]);
    const deps: AgentDeps = {
      channel,
      recordUsage: async () => {},
      fetchUrl: async () => ({ text: "", image: { b64: PNG, mimeType: "image/png" } }),
    };
    const chunks = await collect(runAgent(deps, input()));
    // The same axis a generated image travels, so every surface already knows
    // what to do with it — but marked `fetched`, because the run read these
    // bytes rather than making them and an artifact is what a run produced.
    // Without the mark, redrawing somebody's avatar files the original photo in
    // their gallery alongside the drawing.
    expect(chunks.find((c) => c.image)?.image).toMatchObject({
      b64: PNG,
      mimeType: "image/png",
      fetched: true,
    });
  });
});

describe("running alongside MCP calls", () => {
  it("dispatches concurrently but answers in call order", async () => {
    const channel = new FakeChannel([
      [
        toolCallChunk(0, "c1", FETCH_URL_TOOL_NAME, '{"url":"https://example.test/slow"}'),
        toolCallChunk(1, "c2", "getTime", "{}"),
        usageChunk(10, 5),
      ],
      [contentChunk("done"), usageChunk(8, 4)],
    ]);
    const finished: string[] = [];
    const deps: AgentDeps = {
      channel,
      recordUsage: async () => {},
      // Resolves after the MCP call, so "in flight together" and "answered in
      // order" are two different claims and both are checked.
      fetchUrl: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        finished.push("fetch");
        return { text: "page" };
      },
      callMcpTool: async () => {
        finished.push("mcp");
        return { text: "09:00" };
      },
    };
    const chunks = await collect(
      runAgent(
        deps,
        input({ mcpTools: [{ type: "function", function: { name: "getTime", parameters: {} } }] }),
      ),
    );
    expect(finished).toEqual(["mcp", "fetch"]);
    expect(chunks.filter((c) => c.toolResult).map((c) => c.toolResult?.toolCallId)).toEqual([
      "c1",
      "c2",
    ]);
  });
});
