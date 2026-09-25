import { withConfigurations } from "./agentConfigurations";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleTurn, type MessagingDeps, type TurnInput } from "@/application/messaging/handleTurn";
import type { ReplyChannel } from "@/domain/messaging/reply";
import type { EngineChunk } from "@/domain/llm/types";
import type { Agent, AgentConfiguration } from "@/domain/agent/types";
import type { AgentRepository } from "@/domain/agent/repository";

const NOW = 1_750_000_000_000;

function agentFixture(): Agent {
  return {
    name: "painter",
    displayName: "Painter",
    description: "",
    ownerEmail: "owner@x.com",

    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function configurationFixture(): AgentConfiguration {
  return {
    agentName: "painter",

    systemPrompt: "",

    model: "openai/gpt-5-mini",
    parameters: { piiFiltering: false },
    mcpList: [],
    skillList: [],
    subagentList: [],
  };
}

/**
 * A reply channel that records what the pipeline asked of it. It stands for
 * every chat-bot surface: what is asserted here is the contract an adapter has
 * to satisfy, not how any one of them renders it.
 */
function makeReply() {
  const calls: string[] = [];
  const pushed: string[] = [];
  const steps: Array<{ id: string; title: string; nested?: boolean }> = [];
  const done: Array<{ id: string; title?: string }> = [];
  const images: Array<{ mimeType: string; index: number }> = [];
  const said: string[] = [];
  let finished: { text: string; suffix: string } | undefined;
  let heartbeats = 0;
  let stopped = 0;
  const reply: ReplyChannel = {
    async status(text) {
      calls.push(`status:${text}`);
    },
    async step(id, title, opts) {
      calls.push(`step:${title}`);
      steps.push({ id, title, ...(opts?.nested ? { nested: true } : {}) });
    },
    async stepDone(id, title) {
      calls.push(`stepDone:${title ?? ""}`);
      done.push({ id, ...(title ? { title } : {}) });
    },
    keepStatusAlive() {
      heartbeats += 1;
      return () => {
        stopped += 1;
      };
    },
    async push(fullText) {
      pushed.push(fullText);
    },
    async finish(text, suffix) {
      calls.push("finish");
      finished = { text, suffix };
    },
    async say(text) {
      said.push(text);
    },
    async sendImage(image, index) {
      calls.push("sendImage");
      images.push({ mimeType: image.mimeType, index });
    },
    fileLink: (file) => `[file:${file.name}](${file.url})`,
    warningLine: (text) => `! ${text}`,
  };
  return {
    reply,
    calls,
    pushed,
    steps,
    done,
    images,
    said,
    finished: () => finished,
    heartbeat: () => ({ started: heartbeats, stopped }),
  };
}

function makeDeps(chunks: EngineChunk[]): MessagingDeps & { seen: () => TurnInput["history"] } {
  let seen: TurnInput["history"] = [];
  return {
    runAgent: async function* (input) {
      seen = input.messages.map((message) => ({ message, attachments: [] }));
      for (const chunk of chunks) {
        yield chunk;
      }
    },
    agents: withConfigurations({ get: async () => agentFixture() } as unknown as AgentRepository, ({ get: async () => configurationFixture(), list: async () => [] }).get),

    documents: { extract: async ({ bytes }) => ({ text: Buffer.from(bytes).toString("utf-8") }) },
    seen: () => seen,
  };
}

function turn(overrides: Partial<TurnInput> = {}): TurnInput {
  return {
    agent: agentFixture(),
    configuration: configurationFixture(),
    text: "hello",
    attachments: [],
    history: [],
    conversation: { surface: "slack", id: "C1:1.0" },
    warnings: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("handleTurn", () => {
  it("reports cancellation-state failures during delivery and withholds pending files", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const deps = makeDeps([{ file: { name: "report.txt", mimeType: "text/plain", source: "File", key: "report" } }]);
    deps.signFile = async () => { controller.abort(new Error("Cancellation state unavailable")); return "https://files.test/report"; };
    const reply = makeReply();
    const result = await handleTurn(deps, turn({ signal: controller.signal }), reply.reply);
    expect(result.filesDelivered).toBe(0);
    expect(reply.finished()?.suffix).toContain("Cancellation state unavailable");
  });
  it("honors a stop received after generation while signing a produced file", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const deps = makeDeps([{ file: { name: "report.txt", mimeType: "text/plain", source: "File", key: "report" } }]);
    deps.signFile = async () => { controller.abort(); return "https://files.test/report"; };
    const reply = makeReply();
    const result = await handleTurn(deps, turn({ signal: controller.signal }), reply.reply);
    expect(result.filesDelivered).toBe(0);
    expect(reply.finished()?.suffix).toBe("Stopped by user.");
  });
  it("reports a tool error to the progress sink without preventing a recovered answer", async () => {
    vi.useFakeTimers();
    const deps = makeDeps([
      { toolResult: { toolCallId: "call-1", name: "Search", content: "Error: source unavailable" } },
      { delta: { content: "Here is what I could verify." } },
    ]);
    const reply = makeReply();
    const done = vi.spyOn(reply.reply, "stepDone");
    await handleTurn(deps, turn(), reply.reply);
    expect(done).toHaveBeenCalledWith(expect.any(String), "Search", { failed: true });
    expect(reply.finished()?.text).toBe("Here is what I could verify.");
  });
  it("passes user cancellation to a silent model and preserves partial text without a timeout warning", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const controller = new AbortController();
    const deps = makeDeps([]);
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    deps.runAgent = async function* ({ signal }) {
      yield { delta: { content: "Partial answer" } };
      yield { image: { b64: "aW1hZ2U=", mimeType: "image/png" } };
      ready();
      await new Promise<void>((resolve) => { signal!.addEventListener("abort", () => resolve(), { once: true }); });
      // The facade can finish quietly on cancellation.
    };
    const reply = makeReply();
    const pending = handleTurn(deps, turn({ signal: controller.signal }), reply.reply);
    await started;
    controller.abort();
    await pending;
    expect(reply.finished()).toEqual({ text: "Partial answer", suffix: "Stopped by user." });
    expect(reply.images).toEqual([]);
    expect(reply.heartbeat()).toEqual({ started: 1, stopped: 1 });
  });

  it("does not download or dispatch a turn already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const deps = makeDeps([]);
    const run = vi.spyOn(deps, "runAgent");
    const download = vi.fn();
    const reply = makeReply();
    await handleTurn(deps, turn({ signal: controller.signal, attachments: [{ name: "photo.png", mimeType: "image/png", download }] }), reply.reply);
    expect(download).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(reply.finished()?.suffix).toBe("Stopped by user.");
  });

  it("restores and retains file IDs without putting signed URLs in model history", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const deps = makeDeps([{ file: { name: "new.docx", mimeType: "application/msword", source: "builtin: File", key: "stored", artifactId: "new-id" } }, { done: true }]);
    const append = vi.fn(async () => {});
    deps.fileHistory = {
      recent: async () => [{ role: "assistant", content: "Prior file ID: old-id", createdAt: "2026-09-07T00:00:00.000Z" }],
      append,
    };
    deps.signFile = async () => "https://signed.test/secret";
    const { reply } = makeReply();
    await handleTurn(deps, turn({ actor: { kind: "slack", id: "U1" } }), reply);
    expect(JSON.stringify(deps.seen())).toContain("old-id");
    expect(append).toHaveBeenCalledOnce();
    expect(JSON.stringify(append.mock.calls)).toContain("new-id");
    expect(JSON.stringify(append.mock.calls)).not.toContain("secret");
  });

  it("reads recent historical documents after current attachments within one shared budget", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const deps = makeDeps([{ done: true }]);
    const downloaded: string[] = [];
    const document = (name: string) => ({
      name, mimeType: "text/plain", download: async () => {
        downloaded.push(name);
        return Buffer.from(name);
      },
    });
    deps.documents = { extract: async ({ maxChars }) => ({ text: "가".repeat(Math.min(15_000, maxChars)) }) };
    const { reply, finished } = makeReply();
    await handleTurn(deps, turn({
      attachments: [document("current.txt")],
      history: [
        { message: { role: "user", content: "old" }, attachments: [document("old.txt")] },
        { message: { role: "user", content: "middle" }, attachments: [document("middle.txt")] },
        { message: { role: "assistant", content: "answer" }, attachments: [document("output.txt")] },
        { message: { role: "user", content: "recent" }, attachments: [document("recent.txt")] },
      ],
    }), reply);

    expect(downloaded).toEqual(["current.txt", "recent.txt", "middle.txt"]);
    const messages = deps.seen().map(({ message }) => message.content);
    expect(messages[0]).toBe("old");
    expect(messages[1]).toContain('[Attached file "middle.txt"');
    expect(messages[2]).toBe("answer");
    expect(messages[3]).toContain('[Attached file "recent.txt"');
    expect(messages[4]).toContain('[Attached file "current.txt"');
    expect(messages.join("").match(/가/g)).toHaveLength(40_000);
    expect(finished()?.suffix).toContain("Left out 1 older document attachment");
  });

  it("counts current and historical documents together before downloading", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const deps = makeDeps([{ done: true }]);
    const download = vi.fn(async () => Buffer.from("short"));
    const document = { name: "notes.txt", mimeType: "text/plain", download };
    const { reply, finished } = makeReply();
    await handleTurn(deps, turn({
      attachments: [document],
      history: Array.from({ length: 8 }, (_, index) => ({
        message: { role: "user" as const, content: `question ${index}` }, attachments: [document],
      })),
    }), reply);
    expect(download).toHaveBeenCalledTimes(4);
    expect(finished()?.suffix).toContain("Left out 5 older document attachment");
    expect(deps.seen()[7]?.message.content).toContain("short");
    expect(deps.seen()[4]?.message.content).toBe("question 4");
  });

  it.each([false, true])("reads office documents through the native extractor (failure: %s)", async (fails) => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const deps = makeDeps([{ done: true }]);
    const extract = vi.fn(async () => {
      if (fails) throw new Error("office reader unavailable");
      return { text: "Quarterly revenue" };
    });
    deps.documents = { extract };
    const input = turn({
      actor: { kind: "slack", id: "U1" },
      ownerEmail: "caller@example.com",
      attachments: [{ name: "report.docx", mimeType: "application/octet-stream", download: async () => Buffer.from("office") }],
    });
    const { reply, finished } = makeReply();

    await handleTurn(deps, input, reply);

    expect(extract).toHaveBeenCalledOnce();
    if (fails) {
      expect(finished()?.suffix).toContain("office reader unavailable");
    } else {
      expect(deps.seen().at(-1)?.message.content).toContain("Quarterly revenue");
    }
  });

  it("streams the top-level answer, reports steps at real boundaries, and finishes once", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const deps = makeDeps([
      { delta: { toolCalls: [{ id: "c1", type: "function", function: { name: "search", arguments: "" } }] } },
      { toolResult: { toolCallId: "c1", name: "search (docs)", content: "…" } },
      { delta: { content: "hel" } },
      { delta: { content: "lo" }, author: "child" },
      { delta: { content: "lo" } },
      { done: true },
    ]);
    const { reply, pushed, steps, done, finished, heartbeat } = makeReply();

    const outcome = await handleTurn(deps, turn(), reply);

    expect(pushed).toEqual(["hel", "hello"]);
    expect(steps).toEqual([{ id: expect.any(String), title: "search" }]);
    expect(done).toEqual([{ id: steps[0]!.id, title: "search (docs)" }]);
    expect(finished()).toEqual({ text: "hello", suffix: "" });
    expect(outcome.text).toBe("hello");
    expect(heartbeat()).toEqual({ started: 1, stopped: 1 });
    expect(deps.seen().at(-1)?.message).toEqual({ role: "user", content: "hello" });
  });

  it("names a subagent's step after the agent, and marks it nested", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const deps = makeDeps([
      {
        delta: { toolCalls: [{ id: "c1", type: "function", function: { name: "Skill", arguments: "" } }] },
        author: "child",
      },
      { done: true },
    ]);
    const { reply, steps } = makeReply();

    await handleTurn(deps, turn(), reply);

    expect(steps).toEqual([{ id: expect.any(String), title: "child: Skill", nested: true }]);
  });

  it("keeps a nested tool completion separate from its parent's reused id", async () => {
    const call = { id: "c1", function: { name: "search", arguments: "{}" } };
    const deps = makeDeps([
      { delta: { toolCalls: [call] } },
      { author: "child", transferId: "transfer", delta: { toolCalls: [call] } },
      { author: "child", transferId: "transfer", toolResult: { toolCallId: "c1", name: "child search", content: "child" } },
      { toolResult: { toolCallId: "c1", name: "parent search", content: "parent" } },
      { done: true },
    ]);
    const { reply, steps, done } = makeReply();
    await handleTurn(deps, turn(), reply);
    expect(steps).toHaveLength(2);
    expect(steps[0]!.id).not.toBe(steps[1]!.id);
    expect(done.map((step) => step.id)).toEqual([steps[1]!.id, steps[0]!.id]);
  });

  it("delivers a picture the run drew and leaves a fetched one out beside it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const deps = makeDeps([
      { image: { b64: "AA==", mimeType: "image/png", fetched: true } },
      { image: { b64: "AA==", mimeType: "image/jpeg", prompt: "a cat" } },
      { done: true },
    ]);
    const { reply, images, finished } = makeReply();

    const outcome = await handleTurn(deps, turn(), reply);

    expect(images).toEqual([{ mimeType: "image/jpeg", index: 0 }]);
    expect(outcome.imagesDelivered).toBe(1);
    // A picture is an answer: nothing says the run produced nothing.
    expect(finished()?.suffix).toBe("");
  });

  it("delivers a fetched picture when it is all the run has to show", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const deps = makeDeps([{ image: { b64: "AA==", mimeType: "image/png", fetched: true } }, { done: true }]);
    const { reply, images } = makeReply();

    await handleTurn(deps, turn(), reply);

    expect(images).toHaveLength(1);
  });

  it("links a produced file in the surface's own markup, ahead of the warnings", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const deps: MessagingDeps = {
      ...makeDeps([
        { warning: "skill gone" },
        { file: { name: "report.docx", mimeType: "application/x", source: "mcp: render", key: "k1" } },
        { done: true },
      ]),
      signFile: async () => "https://signed/k1",
    };
    const { reply, finished } = makeReply();

    await handleTurn(deps, turn(), reply);

    expect(finished()?.suffix).toBe("[file:report.docx](https://signed/k1)\n! skill gone");
  });

  it("says a file was not kept when the deployment stores nothing", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const deps = makeDeps([{ file: { name: "report.docx", mimeType: "application/x", source: "mcp: render" } }, { done: true }]);
    const { reply, finished } = makeReply();

    await handleTurn(deps, turn(), reply);

    expect(finished()?.suffix).toContain("not kept");
  });

  it("says so when the run produced nothing at all", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { reply, finished } = makeReply();

    await handleTurn(makeDeps([{ done: true }]), turn(), reply);

    expect(finished()?.suffix).toBe("! The run finished without producing an answer.");
  });

  it("ends the run on a top-level error and keeps going past a subagent's", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const deps = makeDeps([
      { error: "child broke", author: "child" },
      { delta: { content: "still here" } },
      { error: "provider down" },
      { delta: { content: " and more" } },
    ]);
    const { reply, finished } = makeReply();

    await handleTurn(deps, turn(), reply);

    expect(finished()?.text).toBe("still here");
    expect(finished()?.suffix).toBe("! child broke\n! provider down");
  });

  it("does not dispatch an empty turn when nothing survived, and answers with the warnings", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    let dispatched = false;
    const deps = makeDeps([{ done: true }]);
    deps.runAgent = async function* () {
      dispatched = true;
      yield { done: true };
    };
    const { reply, finished } = makeReply();

    await handleTurn(
      deps,
      turn({
        text: "",
        attachments: [
          {
            name: "scan.pdf",
            mimeType: "application/pdf",
            download: async () => {
              throw new Error("unreachable");
            },
          },
        ],
      }),
      reply,
    );

    expect(dispatched).toBe(false);
    expect(finished()?.text).toBe("");
    expect(finished()?.suffix).toContain("Could not read attachment scan.pdf: unreachable");
    // "agent run failed" would blame a run that never started.
    expect(finished()?.suffix).not.toContain("failed");
  });

  it("carries an attached image as a content part and an earlier turn's image with its own turn", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const deps = makeDeps([{ done: true }]);
    const { reply } = makeReply();
    const png = { name: "a.png", mimeType: "image/png", download: async () => Buffer.from("png") };

    await handleTurn(
      deps,
      turn({
        attachments: [png],
        history: [
          { message: { role: "user", content: "earlier" }, attachments: [png], userId: "U1" },
          { message: { role: "assistant", content: "ok" }, attachments: [] },
        ],
      }),
      reply,
    );

    const seen = deps.seen().map((turn) => turn.message);
    expect(seen).toHaveLength(3);
    expect(Array.isArray(seen[0]?.content)).toBe(true);
    expect(seen[1]?.content).toBe("ok");
    const last = seen[2]?.content;
    expect(Array.isArray(last) && last.some((part) => part.type === "image_url")).toBe(true);
  });

  it("reports what it lost before the run alongside what the run lost", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const deps = makeDeps([{ warning: "tool cut" }, { done: true }]);
    const { reply, finished } = makeReply();

    await handleTurn(deps, turn({ warnings: ["history unavailable"] }), reply);

    expect(finished()?.suffix).toBe("! history unavailable\n! tool cut");
  });
});
