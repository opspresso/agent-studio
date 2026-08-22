import { afterEach, describe, expect, it, vi } from "vitest";

// Card builders resolve the public base URL via runtime settings; stub the
// repository so tests never touch DynamoDB.
vi.mock("@/infrastructure/db/repositories/settingsRepository", () => ({
  settingsRepository: { get: async () => null, put: async () => {} },
}));
// The outbound client reaches the network through the SSRF guard, which has its
// own tests; these are about what the client does with the reply.
vi.mock("@/infrastructure/net/publicFetch", () => ({
  fetchPublicUrl: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
}));
import {
  AgentCard,
  SendMessageResponse,
  StreamResponse,
  Task as TaskCodec,
  type Message,
  type Task,
} from "@a2a-js/sdk";
import type { AgentExecutionEvent, ExecutionEventBus, TaskStore } from "@a2a-js/sdk/server";
import { buildAgentCard, buildProjectA2aRpcUrl } from "@/infrastructure/a2a/cards";
import {
  extractA2aImages,
  extractA2aText,
  normalizeAgentCardUrl,
  sendA2aMessage,
} from "@/infrastructure/a2a/client";
import { ProjectA2aExecutor } from "@/application/a2a/executor";
import type { Project, Version } from "@/domain/project/types";
import type { ExecutionDeps } from "@/application/execution/runProject";
import type { LlmChannel } from "@/domain/llm/channel";
import { contentChunk, FakeChannel, toolCallChunk, usageChunk } from "./fakeChannel";
import type { Trace } from "@/domain/trace/types";
import { fakeSkillRepository } from "./fakeSkills";
import {
  Role,
  TaskState,
  agentMessageFixture,
  artifact,
  artifactEvents,
  cardFixture,
  fakeTaskStore,
  messageFixture,
  requestContext,
  statusEvent,
  taskFixture as protocolTaskFixture,
  taskStatus,
  textPart,
} from "./a2aFixtures";

// --- fixtures ---------------------------------------------------------------

function projectFixture(overrides: Partial<Project> = {}): Project {
  return {
    name: "helper",
    displayName: "Helper",
    description: "A helper agent",
    projectType: "llm",
    ownerEmail: "owner@example.com",
    publishedVersion: "v1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function versionFixture(overrides: Partial<Version> = {}): Version {
  return {
    projectName: "helper",
    versionName: "v1",
    systemPrompt: "You are helpful.",
    userPromptTemplate: "{{message}}",
    model: "gpt-test",
    parameters: { piiFiltering: false },
    mcpList: [],
    skillList: [],
    subagentList: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function userMessage(text: string): Message {
  return messageFixture(text);
}

function taskFixture(overrides: Partial<Task> = {}): Task {
  return protocolTaskFixture(overrides);
}

class CollectingBus implements ExecutionEventBus {
  events: AgentExecutionEvent[] = [];
  publish(event: AgentExecutionEvent): void {
    this.events.push(event);
  }
  on(): this {
    return this;
  }
  off(): this {
    return this;
  }
  once(): this {
    return this;
  }
  removeAllListeners(): this {
    return this;
  }
  finished(): void {}
}

// --- cards ------------------------------------------------------------------

describe("buildAgentCard", () => {
  it("builds a JSONRPC card from project and published version", async () => {
    const card = await buildAgentCard(projectFixture(), versionFixture());
    expect(card.name).toBe("Helper");
    expect(card.version).toBe("v1");
    expect(card.capabilities?.streaming).toBe(true);
    expect(card.supportedInterfaces[0]?.url).toBe(await buildProjectA2aRpcUrl("helper"));
    expect(card.skills).toHaveLength(1);
    expect(card.skills[0]?.id).toBe("helper");
  });

  it("advertises image output modes for image projects", async () => {
    const card = await buildAgentCard(
      projectFixture({ projectType: "image" }),
      versionFixture({ model: "openai/gpt-image-2" }),
    );
    expect(card.defaultOutputModes).toEqual(["image/png", "image/jpeg", "image/webp"]);
  });

  it("advertises text-only output for LLM projects", async () => {
    const card = await buildAgentCard(projectFixture({ projectType: "llm" }), versionFixture());
    expect(card.defaultOutputModes).toEqual(["text/plain"]);
  });

  it("advertises text and image output modes for agent projects", async () => {
    const card = await buildAgentCard(projectFixture({ projectType: "agent" }), versionFixture());
    expect(card.defaultOutputModes).toEqual([
      "text/plain",
      "image/png",
      "image/jpeg",
      "image/webp",
    ]);
  });
});

// --- outbound text extraction ----------------------------------------------

describe("extractA2aText", () => {
  it("returns message part text", () => {
    expect(
      extractA2aText({
        messageId: "m2",
        contextId: "c1",
        taskId: "t1",
        role: Role.ROLE_AGENT,
        parts: [textPart("hello "), textPart("world")],
        metadata: undefined,
        extensions: [],
        referenceTaskIds: [],
      }),
    ).toBe("hello world");
  });

  it("prefers artifacts over the final status message", () => {
    const task = taskFixture({
      artifacts: [artifact("result", [textPart("artifact answer")])],
      status: taskStatus(
        TaskState.TASK_STATE_COMPLETED,
        agentMessageFixture("summary repeated", "m3"),
      ),
    });
    expect(extractA2aText(task)).toBe("artifact answer");
  });

  it("falls back to status message, then agent history", () => {
    const statusOnly = taskFixture({
      status: taskStatus(
        TaskState.TASK_STATE_COMPLETED,
        agentMessageFixture("from status", "m4"),
      ),
    });
    expect(extractA2aText(statusOnly)).toBe("from status");

    const historyOnly = taskFixture({
      history: [
        userMessage("question"),
        agentMessageFixture("from history", "m5"),
      ],
    });
    expect(extractA2aText(historyOnly)).toBe("from history");
  });
});

describe("extractA2aImages", () => {
  it("extracts base64 image file parts from artifacts", () => {
    const task = taskFixture({
      artifacts: [
        artifact("image", [
          {
            content: { $case: "raw", value: Buffer.from("aW1n", "base64") },
            mediaType: "image/png",
            filename: "generated.png",
            metadata: undefined,
          },
          {
            content: { $case: "raw", value: Buffer.from("cGRm", "base64") },
            mediaType: "application/pdf",
            filename: "ignored.pdf",
            metadata: undefined,
          },
        ]),
      ],
    });
    expect(extractA2aImages(task)).toEqual([
      { b64: "aW1n", mimeType: "image/png", name: "generated.png" },
    ]);
  });
});

describe("normalizeAgentCardUrl", () => {
  it("appends the well-known path to base URLs and keeps card URLs", () => {
    expect(normalizeAgentCardUrl("https://x.test/api/a2a/p")).toBe(
      "https://x.test/api/a2a/p/.well-known/agent-card.json",
    );
    expect(normalizeAgentCardUrl("https://x.test/api/a2a/p/.well-known/agent-card.json")).toBe(
      "https://x.test/api/a2a/p/.well-known/agent-card.json",
    );
  });
});

// --- outbound send ----------------------------------------------------------

const RPC_URL = "https://remote.test/a2a";
const CARD_URL = `${RPC_URL}/.well-known/agent-card.json`;

function agentCard(streaming: boolean): Response {
  return Response.json(AgentCard.toJSON(cardFixture(streaming, RPC_URL)));
}

/** The events a task-based remote sends: text in two chunks, then a picture. */
const TASK_EVENT = StreamResponse.toJSON({
  payload: {
    $case: "task",
    value: taskFixture({ status: taskStatus(TaskState.TASK_STATE_WORKING) }),
  },
});
const ARTIFACT_OPEN = StreamResponse.toJSON({
  payload: {
    $case: "artifactUpdate",
    value: {
      taskId: "t1",
      contextId: "c1",
      artifact: artifact("a1", [textPart("the ")]),
      append: false,
      lastChunk: false,
      metadata: undefined,
    },
  },
});
const ARTIFACT_APPEND = StreamResponse.toJSON({
  payload: {
    $case: "artifactUpdate",
    value: {
      taskId: "t1",
      contextId: "c1",
      artifact: artifact("a1", [textPart("answer")]),
      append: true,
      lastChunk: true,
      metadata: undefined,
    },
  },
});
const ARTIFACT_IMAGE = StreamResponse.toJSON({
  payload: {
    $case: "artifactUpdate",
    value: {
      taskId: "t1",
      contextId: "c1",
      artifact: artifact("a2", [
        {
          content: { $case: "raw", value: Buffer.from("aGk=", "base64") },
          mediaType: "image/png",
          filename: "p.png",
          metadata: undefined,
        },
      ]),
      append: false,
      lastChunk: true,
      metadata: undefined,
    },
  },
});
const FINAL_STATUS = StreamResponse.toJSON({
  payload: {
    $case: "statusUpdate",
    value: {
      taskId: "t1",
      contextId: "c1",
      status: taskStatus(TaskState.TASK_STATE_COMPLETED),
      metadata: undefined,
    },
  },
});

function statusWire(state: TaskState, text?: string): unknown {
  return StreamResponse.toJSON({
    payload: {
      $case: "statusUpdate",
      value: {
        taskId: "t1",
        contextId: "c1",
        status: taskStatus(state, text ? agentMessageFixture(text) : undefined),
        metadata: undefined,
      },
    },
  });
}

function artifactWire(artifactId: string, text: string): unknown {
  return StreamResponse.toJSON({
    payload: {
      $case: "artifactUpdate",
      value: {
        taskId: "t1",
        contextId: "c1",
        artifact: artifact(artifactId, [textPart(text)]),
        append: false,
        lastChunk: true,
        metadata: undefined,
      },
    },
  });
}
/** What the blocking path returns for the same exchange. */
const FINAL_TASK_VALUE = taskFixture({
  artifacts: [
    artifact("a1", [textPart("the answer")]),
    artifact("a2", [
      {
        content: { $case: "raw", value: Buffer.from("aGk=", "base64") },
        mediaType: "image/png",
        filename: "p.png",
        metadata: undefined,
      },
    ]),
  ],
});
const FINAL_TASK = TaskCodec.toJSON(FINAL_TASK_VALUE);

function sendMessageResult(task: Task): unknown {
  return SendMessageResponse.toJSON({ payload: { $case: "task", value: task } });
}

const STREAMED_REPLY = {
  ok: true,
  text: "the answer",
  images: [{ b64: "aGk=", mimeType: "image/png", name: "p.png" }],
  // The remote's conversation, handed back so the next send can continue it.
  contextId: "c1",
};

function sseFrames(requestId: number, results: unknown[]): string {
  return results
    .map((result) => `data: ${JSON.stringify({ jsonrpc: "2.0", id: requestId, result })}\n\n`)
    .join("");
}

function sseResponse(body: string): Response {
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

/**
 * An SSE body the test feeds one event at a time, to control the gaps.
 *
 * `respond` honours the caller's `signal` the way a real fetch does — tearing
 * the body down on abort. Without that a timeout would fire and the stream
 * would go on reading, which is not how this fails in production.
 */
function manualSse(requestId: number) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    respond(signal?: AbortSignal) {
      signal?.addEventListener("abort", () => {
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        controller.error(error);
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    },
    push(result: unknown) {
      controller.enqueue(encoder.encode(sseFrames(requestId, [result])));
    },
    close() {
      controller.close();
    },
  };
}

/** Answers the card, then hands each RPC call to `rpc`. Records the methods. */
function stubRemote(
  card: Response,
  rpc: (method: string, id: number, signal?: AbortSignal, body?: unknown) => Response,
) {
  const methods: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === CARD_URL) {
      return card;
    }
    const body = JSON.parse(String(init?.body)) as { method: string; id: number };
    methods.push(body.method);
    return rpc(body.method, body.id, init?.signal ?? undefined, body);
  });
  return methods;
}

describe("sendA2aMessage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("collects a streamed reply, appending an artifact continued across events", async () => {
    stubRemote(agentCard(true), (_method, id) =>
      sseResponse(
        sseFrames(id, [TASK_EVENT, ARTIFACT_OPEN, ARTIFACT_APPEND, ARTIFACT_IMAGE, FINAL_STATUS]),
      ),
    );

    await expect(sendA2aMessage(RPC_URL, {}, "hello")).resolves.toEqual(STREAMED_REPLY);
  });

  it("falls back to a blocking send for a card that cannot stream", async () => {
    const methods = stubRemote(agentCard(false), (_method, id) =>
      Response.json({
        jsonrpc: "2.0",
        id,
        result: sendMessageResult(
          taskFixture({
            artifacts: [
              artifact("a1", [textPart("the answer")]),
              artifact("a2", [
                {
                  content: { $case: "raw", value: Buffer.from("aGk=", "base64") },
                  mediaType: "image/png",
                  filename: "p.png",
                  metadata: undefined,
                },
              ]),
            ],
          }),
        ),
      }),
    );

    // The same answer as the streamed path: both read the reply back through
    // `extractA2aText`/`extractA2aImages`, so neither can drift from the other.
    await expect(sendA2aMessage(RPC_URL, {}, "hello")).resolves.toEqual(STREAMED_REPLY);
    // The SDK refuses before any request goes out, so nothing ran twice.
    expect(methods).toEqual(["SendMessage"]);
  });

  it("reports a stream that broke before the task finished, without re-sending it", async () => {
    const methods = stubRemote(agentCard(true), (_method, id) =>
      // A frame the SDK cannot parse ends the stream while the task is still
      // working — the remote may well be mid-delegation, so a second send would
      // run the whole thing twice.
      sseResponse(`${sseFrames(id, [TASK_EVENT, ARTIFACT_OPEN])}data: not-json\n\n`),
    );

    const result = await sendA2aMessage(RPC_URL, {}, "hello");

    expect(result.ok).toBe(false);
    expect(methods).toEqual(["SendStreamingMessage"]);
  });

  it("keeps an answer whose stream broke after the task reached a terminal state", async () => {
    stubRemote(agentCard(true), (_method, id) =>
      // Everything arrived, then the connection tore down ungracefully — a
      // proxy reset, a trailing frame. The finished task is not thrown away.
      sseResponse(
        `${sseFrames(id, [TASK_EVENT, ARTIFACT_OPEN, ARTIFACT_APPEND, ARTIFACT_IMAGE, FINAL_STATUS])}data: not-json\n\n`,
      ),
    );

    await expect(sendA2aMessage(RPC_URL, {}, "hello")).resolves.toEqual(STREAMED_REPLY);
  });

  it("does not re-send when the stream could not be established at all", async () => {
    const methods = stubRemote(agentCard(true), () =>
      // A gateway 502 says nothing about whether the remote took the work, so
      // the blocking path is not a safe retry.
      Response.json({ error: "bad gateway" }, { status: 502 }),
    );

    const result = await sendA2aMessage(RPC_URL, {}, "hello");

    expect(result.ok).toBe(false);
    expect(methods).toEqual(["SendStreamingMessage"]);
  });

  it("reads an answer a remote put in a status message rather than an artifact", async () => {
    const answering = StreamResponse.toJSON({
      payload: {
        $case: "statusUpdate",
        value: {
          taskId: "t1",
          contextId: "c1",
          status: taskStatus(
            TaskState.TASK_STATE_WORKING,
            agentMessageFixture("the answer", "m1"),
          ),
          metadata: undefined,
        },
      },
    });
    stubRemote(agentCard(true), (_method, id) =>
      // The terminal event carries no message, so the reply survives only if
      // the earlier status message reached the task's history — which is where
      // the blocking path would have found it.
      sseResponse(sseFrames(id, [TASK_EVENT, answering, FINAL_STATUS])),
    );

    await expect(sendA2aMessage(RPC_URL, {}, "hello")).resolves.toEqual({
      ok: true,
      text: "the answer",
      images: [],
      contextId: "c1",
    });
  });

  it("sends the contextId it is asked to continue, and none when it is not", async () => {
    const bodies: unknown[] = [];
    // One stub per send: a card `Response` can be read once, and each send
    // fetches it afresh — as a real transfer does.
    const answer = (_method: string, id: number, _signal?: AbortSignal, body?: unknown) => {
      bodies.push(body);
      return Response.json({ jsonrpc: "2.0", id, result: sendMessageResult(FINAL_TASK_VALUE) });
    };
    stubRemote(agentCard(false), answer);
    await sendA2aMessage(RPC_URL, {}, "hello");
    stubRemote(agentCard(false), answer);
    await sendA2aMessage(RPC_URL, {}, "and again", undefined, { contextId: "c1" });

    const messages = bodies.map(
      (body) => (body as { params: { message: { contextId?: string } } }).params.message,
    );
    // The first message opens a conversation: nothing to continue, so the
    // field is absent rather than empty — a remote may treat "" as a real id.
    expect(messages[0]).not.toHaveProperty("contextId");
    expect(messages[1]).toMatchObject({ contextId: "c1" });
  });

  it("returns as soon as the task is final, without waiting for the body to close", async () => {
    vi.useFakeTimers();
    const sse = manualSse(1);
    stubRemote(agentCard(true), (_method, _id, signal) => sse.respond(signal));

    const pending = sendA2aMessage(RPC_URL, {}, "hello");
    await vi.advanceTimersByTimeAsync(0);
    sse.push(TASK_EVENT);
    sse.push(ARTIFACT_OPEN);
    sse.push(ARTIFACT_APPEND);
    sse.push(ARTIFACT_IMAGE);
    sse.push(FINAL_STATUS);
    // The connection is deliberately left open: a remote behind a proxy may
    // hold it, and waiting would burn the idle bound on a finished answer.
    await vi.advanceTimersByTimeAsync(0);

    await expect(pending).resolves.toEqual(STREAMED_REPLY);
  });

  it("says a run was cancelled rather than blaming a timeout that never elapsed", async () => {
    vi.useFakeTimers();
    const cancel = new AbortController();
    const sse = manualSse(1);
    stubRemote(agentCard(true), (_method, _id, signal) => sse.respond(signal));

    const pending = sendA2aMessage(RPC_URL, {}, "hello", cancel.signal);
    await vi.advanceTimersByTimeAsync(0);
    sse.push(TASK_EVENT);
    await vi.advanceTimersByTimeAsync(0);
    // The run's own deadline, well inside the idle bound this never reached.
    cancel.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(await pending).toEqual({ ok: false, error: "Request was cancelled" });
  });

  it("reads a cancellation off the signal, whatever the caller aborted with", async () => {
    // A real fetch rejects with the abort *reason*, and Next.js aborts
    // `request.signal` with its own `ResponseAborted` — an Error that is not
    // named `AbortError` and carries no message. Judged by the error's name,
    // a caller hanging up read as an ordinary failure with an empty reason.
    const cancel = new AbortController();
    const card = agentCard(false);
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === CARD_URL) {
        return card;
      }
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    });

    const pending = sendA2aMessage(RPC_URL, {}, "hello", cancel.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const responseAborted = new Error();
    responseAborted.name = "ResponseAborted";
    cancel.abort(responseAborted);

    expect(await pending).toEqual({ ok: false, error: "Request was cancelled" });
  });

  it("keeps a stream alive past the blocking timeout while events keep arriving", async () => {
    vi.useFakeTimers();
    const sse = manualSse(1);
    stubRemote(agentCard(true), (_method, _id, signal) => sse.respond(signal));

    const pending = sendA2aMessage(RPC_URL, {}, "hello");
    await vi.advanceTimersByTimeAsync(0);

    // Two gaps, each inside the idle bound, adding up to well past what the
    // blocking send allows for the whole exchange.
    sse.push(TASK_EVENT);
    await vi.advanceTimersByTimeAsync(100_000);
    sse.push(ARTIFACT_OPEN);
    await vi.advanceTimersByTimeAsync(100_000);
    sse.push(ARTIFACT_APPEND);
    sse.push(ARTIFACT_IMAGE);
    sse.push(FINAL_STATUS);
    sse.close();
    await vi.advanceTimersByTimeAsync(0);

    await expect(pending).resolves.toEqual(STREAMED_REPLY);
  });

  it("gives up on a stream that goes silent for longer than the idle bound", async () => {
    vi.useFakeTimers();
    const sse = manualSse(1);
    stubRemote(agentCard(true), (_method, _id, signal) => sse.respond(signal));

    const pending = sendA2aMessage(RPC_URL, {}, "hello");
    await vi.advanceTimersByTimeAsync(0);
    sse.push(TASK_EVENT);
    await vi.advanceTimersByTimeAsync(200_000);

    expect(await pending).toEqual({ ok: false, error: expect.stringContaining("timed out") });
  });
});

// --- inbound executor -------------------------------------------------------

/** Pinned so the clock line a prompt carries is deterministic. */
const TEST_NOW = new Date("2026-07-30T06:12:00Z");

function executionDepsFixture(channel: FakeChannel): ExecutionDeps {
  const reject = () => Promise.reject(new Error("not used in this test"));
  return {
    now: () => TEST_NOW,
    projects: { get: reject, list: reject, put: reject, delete: reject },
    versions: { get: reject, list: reject, put: reject, delete: reject },
    skills: fakeSkillRepository(reject),
    mcps: { get: reject, list: reject, put: reject, delete: reject },
    externalAgents: { get: reject, list: reject, put: reject, delete: reject },
    usage: {
      record: async () => {},
      getDay: async () => null,
      claimAlert: async () => false,
      listActorsByProject: reject,
      listByProject: reject,
      listByDateRange: reject,
    },
    channel,
    imageChannel: {
      generateImage: async () => ({
        b64: "aW1n",
        mimeType: "image/png",
        usage: { textInputTokens: 1, imageInputTokens: 0, imageOutputTokens: 2 },
      }),
    },
  } as unknown as ExecutionDeps;
}

function fakeStore(overrides: Partial<TaskStore> = {}): TaskStore {
  return fakeTaskStore(overrides);
}

/** A streaming channel that never yields until its signal aborts, then throws —
 * models a provider that hangs without producing chunks. */
function hangingChannel(): LlmChannel {
  return {
    async chatCompletion() {
      throw new Error("hangingChannel: not used");
    },
    async *chatCompletionStream(params) {
      await new Promise<void>((_resolve, reject) => {
        params.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted", "AbortError")),
        );
      });
      yield contentChunk("unreachable");
    },
  };
}

describe("ProjectA2aExecutor", () => {
  it("publishes task, working, result artifact, and completed", async () => {
    const channel = new FakeChannel([[contentChunk("streamed answer")]]);
    const executor = new ProjectA2aExecutor(
      executionDepsFixture(channel),
      projectFixture(),
      versionFixture(),
      fakeStore(),
    );
    const bus = new CollectingBus();
    await executor.execute(requestContext(userMessage("hi")), bus);

    const kinds = bus.events.map((event) => event.kind);
    expect(kinds[0]).toBe("task");
    expect(kinds).toContain("artifactUpdate");
    const last = bus.events.at(-1);
    expect(last?.kind).toBe("statusUpdate");
    expect(statusEvent(bus.events)?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);

    expect(artifactEvents(bus.events)[0]?.artifact?.parts).toEqual([textPart("streamed answer")]);
  });

  it("runs image projects through the image channel and publishes a file artifact", async () => {
    const executor = new ProjectA2aExecutor(
      executionDepsFixture(new FakeChannel([])),
      projectFixture({ projectType: "image" }),
      versionFixture({ model: "openai/gpt-image-2" }),
      fakeStore(),
    );
    const bus = new CollectingBus();
    await executor.execute(requestContext(userMessage("고양이를 그려줘")), bus);

    expect(artifactEvents(bus.events)[0]?.artifact?.parts).toEqual([
      {
        content: { $case: "raw", value: Buffer.from("aW1n", "base64") },
        mediaType: "image/png",
        filename: "generated.png",
        metadata: undefined,
      },
    ]);
    expect(statusEvent(bus.events)?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
  });

  it("completes past an authored (subagent) error instead of failing the task", async () => {
    // The transfer target's version repo rejects, so the child fails on entry —
    // an *authored* error chunk. The parent answers past it, exactly as chat,
    // Slack and the OpenAI surface treat it; failing the task here threw that
    // answer away.
    const channel = new FakeChannel([
      [
        toolCallChunk(0, "call_t", "transfer_to_agent", '{"agent_name":"child","message":"go"}'),
        usageChunk(1, 1),
      ],
      [contentChunk("recovered without the child"), usageChunk(1, 1)],
    ]);
    const deps = executionDepsFixture(channel);
    // The subagent resolves (the transfer tool is offered), but running it hits
    // the rejecting version repo — the authored-error shape under test.
    (deps as { projects: unknown }).projects = {
      get: async () => projectFixture({ name: "child", projectType: "agent" }),
      list: () => Promise.reject(new Error("not used")),
      put: () => Promise.reject(new Error("not used")),
      delete: () => Promise.reject(new Error("not used")),
    };
    const executor = new ProjectA2aExecutor(
      deps,
      projectFixture({ projectType: "agent" }),
      versionFixture({ subagentList: [{ name: "child", type: "local" }] }),
      fakeStore(),
    );
    const bus = new CollectingBus();
    await executor.execute(requestContext(userMessage("hi")), bus);

    const last = bus.events.at(-1);
    expect(last?.kind).toBe("statusUpdate");
    expect(statusEvent(bus.events)?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(artifactEvents(bus.events)[0]?.artifact?.parts).toEqual([
      textPart("recovered without the child"),
    ]);
  });

  it("forwards the run's warnings on the terminal status", async () => {
    // maxTurn 0 trips the turn guard before the first model call; the engine's
    // warning must reach the A2A caller — it is the only channel that says why
    // the artifact is short.
    const executor = new ProjectA2aExecutor(
      executionDepsFixture(new FakeChannel([])),
      projectFixture({ projectType: "agent" }),
      versionFixture({ maxTurn: 0 }),
      fakeStore(),
    );
    const bus = new CollectingBus();
    await executor.execute(requestContext(userMessage("hi")), bus);

    expect(statusEvent(bus.events)?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    const text = statusEvent(bus.events)?.status?.message?.parts
      .map((part) => (part.content?.$case === "text" ? part.content.value : ""))
      .join("");
    expect(text).toContain("turn limit");
  });
});

describe("ProjectA2aExecutor conversation", () => {
  it("runs under the caller's contextId as its conversation, qualified by the caller", async () => {
    // Read back off the trace the run persisted: the executor's `contextId` is
    // the run's conversation, and the actor — a named client key here — is
    // what keeps it apart from another client's same-spelled context.
    const traces: Trace[] = [];
    const deps = executionDepsFixture(new FakeChannel([[contentChunk("hi"), usageChunk(1, 1)]]));
    deps.traces = {
      put: async (trace: Trace) => {
        traces.push(trace);
      },
      get: async () => null,
      listByProject: async () => traces,
    } as unknown as ExecutionDeps["traces"];
    const executor = new ProjectA2aExecutor(
      deps,
      projectFixture({ projectType: "agent" }),
      versionFixture(),
      fakeStore(),
      { kind: "a2a", id: "billing-bot" },
    );
    const bus = new CollectingBus();
    await executor.execute(requestContext(userMessage("hi"), "t1", "ctx-77"), bus);

    expect(traces[0]?.conversation).toBe("a2a:billing-bot:ctx-77");
  });
});

describe("ProjectA2aExecutor cancel", () => {
  it("persists a canceled state and publishes canceled on cancelTask", async () => {
    const saved: Task[] = [];
    const store = fakeStore({
      load: async () =>
        taskFixture({ id: "t1", contextId: "c1", status: taskStatus(TaskState.TASK_STATE_WORKING) }),
      save: async (task: Task) => {
        saved.push(task);
      },
    });
    const executor = new ProjectA2aExecutor(
      executionDepsFixture(new FakeChannel([])),
      projectFixture(),
      versionFixture(),
      store,
    );
    const bus = new CollectingBus();
    await executor.cancelTask("t1", bus);

    expect(saved).toHaveLength(1);
    expect(saved[0]?.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
    const last = bus.events.at(-1);
    expect(last?.kind).toBe("statusUpdate");
    expect(statusEvent(bus.events)?.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
  });

  it("is a no-op when the task is already terminal", async () => {
    const save = vi.fn(async () => {});
    const store = fakeStore({
      load: async () => taskFixture({ id: "t1", status: taskStatus(TaskState.TASK_STATE_COMPLETED) }),
      save,
    });
    const executor = new ProjectA2aExecutor(
      executionDepsFixture(new FakeChannel([])),
      projectFixture(),
      versionFixture(),
      store,
    );
    const bus = new CollectingBus();
    await executor.cancelTask("t1", bus);

    expect(save).not.toHaveBeenCalled();
    expect(bus.events).toHaveLength(0);
  });

  it("publishes canceled, not completed, when a cancel raced into the store before the run finished", async () => {
    // The run completes synchronously, before the 2s background poll fires, so
    // the controller is never aborted — the terminal decision must still consult
    // the authoritative store rather than the lagging local signal.
    const channel = new FakeChannel([[contentChunk("answer")]]);
    const store = fakeStore({
      load: async () =>
        taskFixture({ id: "t1", contextId: "c1", status: taskStatus(TaskState.TASK_STATE_CANCELED) }),
    });
    const executor = new ProjectA2aExecutor(
      executionDepsFixture(channel),
      projectFixture(),
      versionFixture(),
      store,
    );
    const bus = new CollectingBus();
    await executor.execute(requestContext(userMessage("hi")), bus);

    expect(statusEvent(bus.events)?.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
  });

  it("publishes canceled for an image run when a cancel raced into the store", async () => {
    const store = fakeStore({
      load: async () =>
        taskFixture({ id: "t1", contextId: "c1", status: taskStatus(TaskState.TASK_STATE_CANCELED) }),
    });
    const executor = new ProjectA2aExecutor(
      executionDepsFixture(new FakeChannel([])),
      projectFixture({ projectType: "image" }),
      versionFixture({ model: "openai/gpt-image-2" }),
      store,
    );
    const bus = new CollectingBus();
    await executor.execute(requestContext(userMessage("draw")), bus);

    expect(statusEvent(bus.events)?.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
  });

  it("aborts a hung streaming run when a cancel is persisted (no new chunks)", async () => {
    vi.useFakeTimers();
    try {
      const deps = {
        ...executionDepsFixture(new FakeChannel([])),
        channel: hangingChannel(),
      } as unknown as ExecutionDeps;
      const store = fakeStore({
        load: async () =>
          taskFixture({ id: "t1", contextId: "c1", status: taskStatus(TaskState.TASK_STATE_CANCELED) }),
      });
      const executor = new ProjectA2aExecutor(deps, projectFixture(), versionFixture(), store);
      const bus = new CollectingBus();
      const done = executor.execute(requestContext(userMessage("hi")), bus);
      // The provider never yields; advance time so the background poll reads the
      // store, sees canceled, and aborts the run.
      await vi.advanceTimersByTimeAsync(2100);
      await done;

      expect(statusEvent(bus.events)?.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
      expect(bus.events.some((event) => event.kind === "artifactUpdate")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts a hung image run when a cancel is persisted", async () => {
    vi.useFakeTimers();
    try {
      const imageChannel = {
        generateImage: (params: { signal?: AbortSignal }) =>
          new Promise<never>((_resolve, reject) => {
            params.signal?.addEventListener("abort", () =>
              reject(new DOMException("The operation was aborted", "AbortError")),
            );
          }),
      };
      const deps = {
        ...executionDepsFixture(new FakeChannel([])),
        imageChannel,
      } as unknown as ExecutionDeps;
      const store = fakeStore({
        load: async () =>
          taskFixture({ id: "t1", contextId: "c1", status: taskStatus(TaskState.TASK_STATE_CANCELED) }),
      });
      const executor = new ProjectA2aExecutor(
        deps,
        projectFixture({ projectType: "image" }),
        versionFixture({ model: "openai/gpt-image-2" }),
        store,
      );
      const bus = new CollectingBus();
      const done = executor.execute(requestContext(userMessage("draw a cat")), bus);
      await vi.advanceTimersByTimeAsync(2100);
      await done;

      expect(statusEvent(bus.events)?.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
      expect(bus.events.some((event) => event.kind === "artifactUpdate")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// --- protocol audit: card, outbound states, inbound parts ------------------

describe("buildAgentCard — what a peer needs to call us", () => {
  it("declares the X-A2A-Key scheme the endpoint requires, and what it can take", async () => {
    const card = await buildAgentCard(projectFixture({ projectType: "agent" }), versionFixture());
    expect(card.securitySchemes).toEqual({
      a2aKey: {
        scheme: {
          $case: "apiKeySecurityScheme",
          value: {
            description: "Agent Studio A2A client key",
            location: "header",
            name: "X-A2A-Key",
          },
        },
      },
    });
    expect(card.securityRequirements).toEqual([
      { schemes: { a2aKey: { list: [] } } },
    ]);
    expect(card.capabilities).toEqual({
      streaming: true,
      pushNotifications: false,
      extensions: [],
    });
    expect(card.defaultInputModes).toEqual(["text/plain", "image/png", "image/jpeg", "image/webp"]);
    expect(card.skills[0]?.tags).toEqual(["agent-studio", "agent"]);
    // An image project takes a picture to edit beside its prompt.
    const image = await buildAgentCard(projectFixture({ projectType: "image" }), versionFixture());
    expect(image.defaultInputModes).toEqual(["text/plain", "image/png", "image/jpeg", "image/webp"]);
  });
});

describe("sendA2aMessage — the task's state decides", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("reports a failed task as a failure, with its reason, never as the answer", async () => {
    stubRemote(agentCard(true), (_method, id) =>
      sseResponse(
        sseFrames(id, [
          TASK_EVENT,
          statusWire(TaskState.TASK_STATE_FAILED, "Agent execution error: boom"),
        ]),
      ),
    );
    await expect(sendA2aMessage(RPC_URL, {}, "hello")).resolves.toEqual({
      ok: false,
      error: "Remote task failed: Agent execution error: boom",
    });
  });

  it("hands an input-required task back as a question with the ids to answer it", async () => {
    stubRemote(agentCard(true), (_method, id) =>
      sseResponse(
        sseFrames(id, [
          TASK_EVENT,
          statusWire(TaskState.TASK_STATE_INPUT_REQUIRED, "Which year?"),
        ]),
      ),
    );
    await expect(sendA2aMessage(RPC_URL, {}, "sales?")).resolves.toEqual({
      ok: false,
      error: "Remote agent needs input before it can continue: Which year?",
      continuation: { contextId: "c1", taskId: "t1" },
    });
  });

  it("sends the parked task's id back when answering it", async () => {
    const bodies: unknown[] = [];
    stubRemote(agentCard(true), (_method, id, _signal, body) => {
      bodies.push(body);
      return sseResponse(sseFrames(id, [TASK_EVENT, ARTIFACT_OPEN, FINAL_STATUS]));
    });
    await sendA2aMessage(RPC_URL, {}, "2025", undefined, { contextId: "c1", taskId: "t1" });
    expect(bodies[0]).toMatchObject({ params: { message: { contextId: "c1", taskId: "t1" } } });
  });

  it("refuses a card whose endpoint is on another origin, before any credential is sent", async () => {
    const methods = stubRemote(
      Response.json(AgentCard.toJSON(cardFixture(true, "https://elsewhere.test/a2a"))),
      (_method, id) => sseResponse(sseFrames(id, [TASK_EVENT, FINAL_STATUS])),
    );
    const result = await sendA2aMessage(RPC_URL, { Authorization: "Bearer secret" }, "hello");
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("https://elsewhere.test") });
    expect(methods).toEqual([]);
  });

  it("follows a blocking send that was answered with a live task until it settles", async () => {
    vi.useFakeTimers();
    const methods = stubRemote(agentCard(false), (method, id) => {
      if (method === "SendMessage") {
        return Response.json({
          jsonrpc: "2.0",
          id,
          result: sendMessageResult(
            taskFixture({ status: taskStatus(TaskState.TASK_STATE_SUBMITTED) }),
          ),
        });
      }
      return Response.json({ jsonrpc: "2.0", id, result: FINAL_TASK });
    });
    const pending = sendA2aMessage(RPC_URL, {}, "hello");
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toMatchObject({ ok: true, text: "the answer" });
    expect(methods).toEqual(["SendMessage", "GetTask"]);
  });

  it("stops a reply that grows past the bound instead of holding it", async () => {
    stubRemote(agentCard(true), (_method, id) =>
      sseResponse(
        sseFrames(id, [
          TASK_EVENT,
          artifactWire("big", "x".repeat(2 * 1024 * 1024 + 1)),
          FINAL_STATUS,
        ]),
      ),
    );
    await expect(sendA2aMessage(RPC_URL, {}, "hello")).resolves.toEqual({
      ok: false,
      error: "A2A reply exceeds 2MB",
    });
  });
});

describe("ProjectA2aExecutor — what a message may carry", () => {
  it("hands an image project the picture it was sent, to edit rather than ignore", async () => {
    const deps = executionDepsFixture(new FakeChannel([]));
    const sources: unknown[] = [];
    deps.imageChannel.editImage = (async (params: { images: unknown[] }) => {
      sources.push(...params.images);
      return {
        b64: "aW1n",
        mimeType: "image/png",
        usage: { textInputTokens: 1, imageInputTokens: 1, imageOutputTokens: 1 },
      };
    }) as ExecutionDeps["imageChannel"]["editImage"];
    const executor = new ProjectA2aExecutor(
      deps,
      projectFixture({ projectType: "image" }),
      versionFixture({ model: "openai/gpt-image-2" }),
      fakeStore(),
    );
    const bus = new CollectingBus();
    const message: Message = {
      ...messageFixture("make it blue"),
      parts: [
        textPart("make it blue"),
        {
          content: { $case: "raw", value: Buffer.from("AAAA", "base64") },
          mediaType: "image/png",
          filename: "p.png",
          metadata: undefined,
        },
      ],
    };
    await executor.execute(requestContext(message), bus);
    expect(sources).toEqual([{ b64: "AAAA", mimeType: "image/png" }]);
    expect(statusEvent(bus.events)?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
  });

  it("hands an image file part to the model beside the text, and closes the artifact", async () => {
    const channel = new FakeChannel([[contentChunk("a cat")]]);
    const executor = new ProjectA2aExecutor(
      executionDepsFixture(channel),
      projectFixture({ projectType: "agent" }),
      versionFixture({ model: "google/gemini-2.5-flash" }),
      fakeStore(),
    );
    const bus = new CollectingBus();
    const message: Message = {
      ...messageFixture("what is this?"),
      parts: [
        textPart("what is this?"),
        {
          content: { $case: "raw", value: Buffer.from("AAAA", "base64") },
          mediaType: "image/png",
          filename: "p.png",
          metadata: undefined,
        },
      ],
    };
    await executor.execute(requestContext(message), bus);

    const sent = channel.seenParams[0]!.messages.at(-1)!.content;
    expect(sent).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ]);
    const last = artifactEvents(bus.events).at(-1);
    expect(last?.lastChunk).toBe(true);
    expect(last?.append).toBe(false);
  });
});
