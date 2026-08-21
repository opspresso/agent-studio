import { describe, expect, it } from "vitest";
import type { EngineChunk } from "@/domain/llm/types";
import type {
  ChannelChunk,
  ChannelCompletion,
  ChannelParams,
  LlmChannel,
} from "@/domain/llm/channel";
import { runAgent, type AgentDeps, type RunAgentInput } from "@/application/llm/engine";
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
const BODY = "<!doctype html><title>q3</title>" + "<p>revenue</p>".repeat(400);

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
  it("swaps the body for its size, and only for this tool", async () => {
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
    expect(shown.content).toBe(`[${Buffer.byteLength(BODY, "utf8")} bytes, kept as the file]`);
    // Everything else about the call is announced as it was made.
    expect(shown.name).toBe("q3");
    expect(shown.mime_type).toBe("text/html");
  });

  it("still gives the provider the call the model actually made", async () => {
    // The elision is for the consumers that keep it, not for the model: a run
    // whose own assistant message disagreed with what it emitted is a different
    // bug.
    const channel = new FakeChannel([
      [saveCall("c1", BODY), usageChunk(10, 5)],
      [contentChunk("done"), usageChunk(4, 2)],
    ]);
    await collect(runAgent({ ...saver(), channel }, input()));

    expect(sentBack(channel, "c1").content).toBe(BODY);
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
