import { describe, expect, it, vi } from "vitest";
import type { ContentPart, EngineChunk } from "@/domain/llm/types";
import {
  buildTransferTranscript,
  runAgent,
  type AgentDeps,
  type RunAgentInput,
} from "@/application/llm/engine";
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
      return { text: "sunny" };
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

  it("dispatches a builtin's name to MCP when that builtin is not offered", async () => {
    // `loadSkillContent` is injected on every agent run, so the dep alone cannot
    // decide who serves a call named `Skill`. With no skills connected the
    // builtin is not offered, and the name belongs to whoever declared it.
    const channel = new FakeChannel([
      [toolCallChunk(0, "call_1", "Skill", '{"skill_name":"x"}'), usageChunk(1, 1)],
      [contentChunk("done"), usageChunk(1, 1)],
    ]);
    const called: string[] = [];
    const deps: AgentDeps = {
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
    // Two turns spoke, so a blank line separates them — this used to read
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

describe("the conversation a transfer carries is bounded", () => {
  /** Capture what the engine hands the runner as the transcript. */
  function captureTranscript() {
    const seen: { transcript?: string } = {};
    const runSubagent = vi.fn(async function* (
      _agentName: string,
      _message: string,
      _turn: number,
      _maxTurn: number,
      _images?: unknown,
      transcript?: string,
    ): AsyncGenerator<EngineChunk, string> {
      seen.transcript = transcript;
      return "done";
    });
    return { seen, runSubagent };
  }

  async function runWith(messages: RunAgentInput["messages"]) {
    const channel = new FakeChannel([
      [
        toolCallChunk(0, "call_t", "transfer_to_agent", '{"agent_name":"child","message":"go"}'),
        usageChunk(1, 1),
      ],
      [contentChunk("done"), usageChunk(1, 1)],
    ]);
    const { seen, runSubagent } = captureTranscript();
    const chunks = await collect(
      runAgent(
        { channel, recordUsage: async () => {}, runSubagent },
        {
          projectName: "parent",
          model: MODEL,
          messages,
          subagents: [{ name: "child", description: "a child agent", type: "local" }],
        },
      ),
    );
    return { chunks, transcript: seen.transcript };
  }

  it("drops the oldest turns and says so, in the transcript and to the reader", async () => {
    // A chain re-sends this at every hop, so the budget is far below what a
    // top-level run carries — a long chat necessarily loses its oldest turns.
    const long = "x".repeat(900);
    const history = Array.from({ length: 20 }, (_, i) => ({
      role: "user" as const,
      content: `turn ${i} ${long}`,
    }));
    const { chunks, transcript } = await runWith([...history, { role: "user", content: "now go" }]);

    expect(transcript).toBeDefined();
    // Newest-first spending: the turns nearest the question survive.
    expect(transcript).toContain("turn 19");
    expect(transcript).not.toContain("turn 0 ");
    // The child cannot see the run's warnings, so the gap is named in the text
    // it does see — a gap it cannot see is one it will answer around.
    expect(transcript).toMatch(/…\(\d+ earlier turn\(s\) omitted\)/);
    expect(
      chunks.some((c) => c.warning?.includes("left out of the context handed to other agents")),
    ).toBe(true);
  });

  it("warns nobody when the whole conversation fits", async () => {
    const { chunks, transcript } = await runWith([
      { role: "user", content: "draw a cat" },
      { role: "assistant", content: "Here is an orange cat." },
      { role: "user", content: "now go" },
    ]);

    expect(transcript).toContain("User: draw a cat");
    expect(transcript).not.toContain("omitted");
    expect(chunks.some((c) => c.warning)).toBe(false);
  });

  it("hands over nothing when there is no conversation before the request", async () => {
    const { chunks, transcript } = await runWith([{ role: "user", content: "now go" }]);

    expect(transcript).toBeUndefined();
    expect(chunks.some((c) => c.warning)).toBe(false);
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

describe("runAgent separates the version's prompt from what the engine appends", () => {
  async function systemPromptFor(input: Partial<Parameters<typeof runAgent>[1]>): Promise<string> {
    const channel = new FakeChannel([[contentChunk("ok"), usageChunk(1, 1)]]);
    await collect(
      runAgent(
        { channel, runSubagent: async function* () {
            return "";
          } },
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

  it("marks where the version's prompt ends and the generated block begins", async () => {
    // Without the break the generated `##` sections are indistinguishable from
    // headings the prompt author wrote, and "your own instructions" — which the
    // routing rule is anchored to — has no referent.
    const content = await systemPromptFor({
      subagents: [{ name: "painter", description: "draws pictures", type: "local" }],
    });
    expect(content).toContain("You are the front desk.\n\n---\n\n# Runtime capabilities");
    expect(content.indexOf("# Runtime capabilities")).toBeLessThan(
      content.indexOf("## Available Agents"),
    );
  });

  it("states when to use a capability exactly once, naming only what the run has", async () => {
    const content = await systemPromptFor({
      subagents: [{ name: "painter", description: "draws pictures", type: "local" }],
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
      subagents: [{ name: "painter", description: "draws pictures", type: "local" }],
      mcpTools: [{ type: "function", function: { name: "search_repos", parameters: {} } }],
      mcpServers: [{ name: "github", description: "repos", toolNames: ["search_repos"] }],
    });
    expect(content).toContain(
      "Within that role, load a skill when you need guidance on how to carry it out, call a tool when you need data or an action from outside this conversation, or transfer to an agent whose description covers the request better than your instructions do.",
    );
  });

  it("leaves a version that reaches nothing exactly as its author wrote it", async () => {
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

  it("keeps the table intact when a description spans lines or contains a pipe", async () => {
    // Descriptions are a single markdown table cell. A newline would end the
    // row early and orphan the remaining servers; a pipe would add a column.
    const channel = new FakeChannel([[contentChunk("ok"), usageChunk(1, 1)]]);
    await collect(
      runAgent(
        { channel },
        {
          projectName: "p",
          model: MODEL,
          messages: [{ role: "user", content: "hi" }],
          mcpTools: [{ type: "function", function: { name: "a", parameters: {} } }],
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
        { channel, loadSkillContent: async () => "" },
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

  it("lists subagents in a table shaped like the other sections", async () => {
    const channel = new FakeChannel([[contentChunk("ok"), usageChunk(1, 1)]]);
    await collect(
      runAgent(
        { channel, runSubagent: async function* () {
            return "";
          } },
        {
          projectName: "p",
          model: MODEL,
          systemPrompt: "base prompt",
          messages: [{ role: "user", content: "hi" }],
          subagents: [
            { name: "painter", description: "draws pictures", type: "local" },
            { name: "blank", description: "", type: "local" },
          ],
        },
      ),
    );

    const content = String(channel.seenParams[0]?.messages[0]?.content);
    expect(content).toContain("## Available Agents");
    expect(content).toContain("| painter | local | draws pictures |");
    expect(content).toContain("| blank | local | No description |");
    expect(content).toContain(
      "Recent conversation may be passed as background depending on the agent type, but `message` must always be self-contained.",
    );
    expect(content).toContain("Remote agents cannot receive images.");
    // `agent_name` is an enum, so the prompt does not restate which names are legal.
    expect(content).not.toContain("NOTE:");
    // Nothing points the model at a description it is never given.
    expect(content).not.toContain("your description");
  });

  it("keeps the agent table intact when a description spans lines or contains a pipe", async () => {
    const channel = new FakeChannel([[contentChunk("ok"), usageChunk(1, 1)]]);
    await collect(
      runAgent(
        { channel, runSubagent: async function* () {
            return "";
          } },
        {
          projectName: "p",
          model: MODEL,
          messages: [{ role: "user", content: "hi" }],
          subagents: [
            { name: "multi", description: "  first line\n\n  second | piped  ", type: "local" },
            { name: "after", description: "still listed", type: "remote" },
          ],
        },
      ),
    );

    const content = String(channel.seenParams[0]?.messages[0]?.content);
    expect(content).toContain("| multi | local | first line second \\| piped |");
    expect(content).toContain("| after | remote | still listed |");
    const tableLines = content
      .split("\n")
      .filter((line) => line.startsWith("| ") && !line.startsWith("|--"));
    expect(tableLines).toHaveLength(3); // header + 2 agents
  });

  it("does not offer image transfer when every connected agent is remote", async () => {
    const channel = new FakeChannel([[contentChunk("ok"), usageChunk(1, 1)]]);
    await collect(
      runAgent(
        {
          channel,
          runSubagent: async function* () {
            return "";
          },
        },
        {
          projectName: "p",
          model: MODEL,
          messages: [{ role: "user", content: "hi" }],
          subagents: [{ name: "remote", description: "external", type: "remote" }],
        },
      ),
    );

    const transfer = channel.seenParams[0]?.tools?.find(
      (tool) => tool.function.name === "transfer_to_agent",
    );
    expect(transfer?.function.parameters?.properties).not.toHaveProperty("image_ids");
    expect(String(channel.seenParams[0]?.messages[0]?.content)).not.toContain(
      "## Available Images",
    );
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
        { channel },
        { projectName: "p", model: MODEL, messages: IMAGE_MESSAGE },
      ),
    );

    // messages[0] is the system prompt; the user turn keeps its parts as-is.
    expect(channel.seenParams[0]?.messages.at(-1)?.content).toEqual(IMAGE_MESSAGE[0]?.content);
  });

  it("rejects a model that does not accept image input", async () => {
    const channel = new FakeChannel([[contentChunk("never"), usageChunk(1, 1)]]);

    await expect(
      collect(
        runAgent(
          { channel },
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
        runAgent({ channel }, { projectName: "p", model: "who/knows", messages: IMAGE_MESSAGE }),
      ),
    ).rejects.toThrow("not in the registry");
  });

  it("drops a fallback model that cannot read the images", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // First script rejects with a retryable error so a live fallback would be used.
    const channel = new FakeChannel([[contentChunk("ok"), usageChunk(1, 1)]]);

    await collect(
      runAgent(
        { channel },
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
        { channel },
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
    expect(image).toEqual({ type: "image_url", image_url: { url: DATA_URL } });
  });
});

describe("runAgent skill system prompt", () => {
  it("keeps the skill table intact when a description spans lines", async () => {
    // Synced skills take their description from SKILL.md frontmatter, which is
    // not constrained to one line the way the console input is.
    const channel = new FakeChannel([[contentChunk("ok"), usageChunk(1, 1)]]);
    await collect(
      runAgent(
        { channel, loadSkillContent: async () => "" },
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
  const deps = (channel: FakeChannel): AgentDeps => ({
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
 * A turn bigger than the whole transfer budget used to be dropped outright,
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
