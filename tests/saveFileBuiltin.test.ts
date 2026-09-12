import { scriptedModels } from "./scriptedModels";
import { describe, expect, it } from "vitest";
import type { EngineChunk } from "@/domain/llm/types";
import type {
  ChannelChunk,
  ChannelCompletion,
  ChannelParams,
  LlmChannel,
} from "@/domain/llm/channel";
import { runAgent, type AgentDeps, type RunAgentInput } from "@/application/runtime";
import { SAVE_FILE_TOOL_NAME } from "@/application/llm/agentAssembly";
import { buildFileSaver } from "@/application/execution/saveFileTool";
import type { ArtifactStorage } from "@/application/artifact/storeArtifact";
import { contentChunk, FakeChannel, toolCallChunk, usageChunk } from "./fakeChannel";

async function collect(gen: AsyncGenerator<EngineChunk>): Promise<EngineChunk[]> {
  const chunks: EngineChunk[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

const MODEL = "google/gemini-2.5-flash";
/** Past `MAX_TOOL_ARG_BYTES`, which is what the bound is keyed to. */
const BODY = "<!doctype html><title>q3</title>" + "<p>revenue</p>".repeat(2000);

function input(over: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    projectName: "p",
    model: MODEL,
    systemPrompt: "s",
    messages: [{ role: "user", content: "write it up" }],
    ...over,
  };
}

function saver(): AgentDeps {
  return {
    channel: new FakeChannel([]),
    recordUsage: async () => {},
    saveFile: buildFileSaver({ artifacts: {} as ArtifactStorage }),
  };
}

function saveCall(id: string, content: string, name = "q3", index = 0): ChannelChunk {
  return toolCallChunk(
    index,
    id,
    SAVE_FILE_TOOL_NAME,
    JSON.stringify({ name, mime_type: "text/html", content }),
  );
}

/** The arguments the announced chunk carried for one call. */
function announced(chunks: EngineChunk[], id: string): Record<string, unknown> {
  for (const chunk of chunks) {
    for (const call of chunk.delta?.toolCalls ?? []) {
      if (call.id === id) {
        return JSON.parse(String(call.function?.arguments ?? "{}"));
      }
    }
  }
  throw new Error(`no announced call ${id}`);
}

/** The same call as the provider is given it back on the assistant message. */
function sentBack(channel: FakeChannel, id: string): Record<string, unknown> {
  const messages = channel.seenParams[1]?.messages ?? [];
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) {
      if (call.id === id) {
        return JSON.parse(String(call.function?.arguments ?? "{}"));
      }
    }
  }
  throw new Error(`call ${id} never went back to the provider`);
}

describe("announcing a call that carries a whole file", () => {
  it("swaps the body for its size", async () => {
    // An announced call is kept by everything downstream — rendered, buffered in
    // the run log, and persisted onto an assistant message that is one 400KB
    // item. `tool_calls` is the axis nothing truncates, so the body cannot ride
    // on it.
    const channel = new FakeChannel([
      [saveCall("c1", BODY), usageChunk(10, 5)],
      [contentChunk("done"), usageChunk(4, 2)],
    ]);
    const chunks = await collect(runAgent({ ...saver(), channel }, input()));

    const shown = announced(chunks, "c1");
    expect(String(shown.content)).toContain(`${Buffer.byteLength(BODY, "utf8")} bytes`);
    expect(String(shown.content)).toContain("elided");
    // Everything else about the call is kept as it was made.
    expect(shown.name).toBe("q3");
    expect(shown.mime_type).toBe("text/html");
  });

  it("keeps it out of the assistant message the provider gets back too", async () => {
    // The other half of the same failure, and the worse one: that message is
    // re-sent on every remaining turn and `contextBudget` cannot cut it, so a
    // megabyte of content is ~350k tokens per turn — past the window of most
    // of the catalog, i.e. a provider 400 mid-run after the file was delivered.
    const channel = new FakeChannel([
      [saveCall("c1", BODY), usageChunk(10, 5)],
      [contentChunk("done"), usageChunk(4, 2)],
    ]);
    await collect(runAgent({ ...saver(), channel }, input()));

    const sent = sentBack(channel, "c1");
    expect(sent.content).not.toBe(BODY);
    expect(String(sent.content)).toContain("elided");
    // The model is not deprived: the tool result on the same turn already said
    // the file exists and what it is called.
    expect(sent.name).toBe("q3");
  });

  it("bounds a call whose arguments never parsed, which is how a big one arrives", async () => {
    // The provider cuts the turn at its output limit part-way through the file,
    // so nothing parses and the accumulator has no cap of its own.
    const channel = new FakeChannel([
      [
        toolCallChunk(0, "c1", SAVE_FILE_TOOL_NAME, `{"name":"q3","content":"${BODY}`),
        usageChunk(10, 5),
      ],
      [contentChunk("done"), usageChunk(4, 2)],
    ]);
    const chunks = await collect(runAgent({ ...saver(), channel }, input()));

    const raw = chunks.flatMap((chunk) => chunk.delta?.toolCalls ?? []);
    const args = String(raw[0]?.function?.arguments ?? "");
    expect(args).toContain("…[truncated]");
    expect(Buffer.byteLength(args, "utf8")).toBeLessThan(Buffer.byteLength(BODY, "utf8"));
  });

  it("is keyed to size, not to a tool name", async () => {
    // The hazard is a large argument. SaveFile is only the first tool to have
    // one — a document renderer takes the document's text.
    const channel = new FakeChannel([
      [toolCallChunk(0, "c1", "render_document", JSON.stringify({ content: BODY })), usageChunk(10, 5)],
      [contentChunk("done"), usageChunk(4, 2)],
    ]);
    const chunks = await collect(
      runAgent({ ...saver(), channel, callMcpTool: async () => ({ text: "ok" }) }, input()),
    );

    expect(String(announced(chunks, "c1").content)).toContain("elided");
  });
});

describe("what the run yields for a saved file", () => {
  it("names the builtin as the source, not an MCP server", async () => {
    const channel = new FakeChannel([
      [saveCall("c1", "<p>hi"), usageChunk(10, 5)],
      [contentChunk("done"), usageChunk(4, 2)],
    ]);
    const chunks = await collect(runAgent({ ...saver(), channel }, input()));

    const file = chunks.find((chunk) => chunk.file)?.file;
    expect(file?.name).toBe("q3.html");
    expect(file?.source).toBe(`builtin: ${SAVE_FILE_TOOL_NAME}`);
  });

  it("stops after the run's file limit and says so rather than failing", async () => {
    const calls = Array.from({ length: 11 }, (_, i) => saveCall(`c${i}`, `<p>${i}`, `f${i}`, i));
    const channel = new FakeChannel([
      [...calls, usageChunk(10, 5)],
      [contentChunk("done"), usageChunk(4, 2)],
    ]);
    const chunks = await collect(runAgent({ ...saver(), channel }, input()));

    const files = chunks.filter((chunk) => chunk.file);
    expect(files).toHaveLength(10);
    const refusal = chunks.find((chunk) => chunk.toolResult?.toolCallId === "c10")?.toolResult?.content;
    expect(refusal).toContain("limit");
  });
});

/** Echoes back whatever it was sent, as a SaveFile call carrying it. */
class SaveWhatItSaw implements LlmChannel {
  getModel(name?: string) { return scriptedModels(this).getModel(name); }
  calls = 0;
  readonly seenParams: ChannelParams[] = [];

  async chatCompletion(): Promise<ChannelCompletion> {
    throw new Error("streaming only");
  }

  async *chatCompletionStream(params: ChannelParams): AsyncGenerator<ChannelChunk> {
    this.seenParams.push(params);
    if (this.calls++ > 0) {
      yield contentChunk("done");
      yield usageChunk(4, 2);
      return;
    }
    // Whatever reached the model — masked, if this run filters.
    const seen = String(params.messages.at(-1)?.content ?? "");
    yield saveCall("c1", `<p>${seen}`);
    yield usageChunk(10, 5);
  }
}

describe("a saved file and the PII boundary", () => {
  it("writes the restored text, because the reader is on this side of it", async () => {
    // The masked copy is for what crosses to another model. A file is delivered
    // to the person who asked for it, beside an answer that carries the real
    // values — a report full of their own placeholders is the bug.
    const channel = new SaveWhatItSaw();
    const saved: string[] = [];
    const deps: AgentDeps = {
      channel,
      recordUsage: async () => {},
      saveFile: async ({ content }) => {
        saved.push(content);
        return { text: "Saved." };
      },
    };

    await collect(
      runAgent(
        deps,
        input({
          messages: [{ role: "user", content: "write up email@example.com" }],
          parameters: { piiFiltering: true },
        }),
      ),
    );

    const sent = String(channel.seenParams[0]?.messages.at(-1)?.content ?? "");
    expect(sent).not.toContain("email@example.com");
    expect(saved[0]).toContain("email@example.com");
  });
});
