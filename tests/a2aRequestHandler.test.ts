import { SendMessageRequest as SendMessageRequestCodec, type SendMessageRequest, type Task } from "@a2a-js/sdk";
import {
  ContentTypeNotSupportedError,
  RequestMalformedError,
  TaskNotFoundError,
  UnsupportedOperationError,
} from "@a2a-js/sdk/errors";
import {
  AgentEvent,
  JsonRpcTransportHandler,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
  type TaskStore,
} from "@a2a-js/sdk/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectRequestHandler, unsupportedPart } from "@/application/a2a/requestHandler";
import {
  TEST_CALL_CONTEXT,
  TaskState,
  artifact,
  cardFixture,
  fakeTaskStore,
  messageFixture,
  taskFixture,
  taskStatus,
  textPart,
} from "./a2aFixtures";

const CARD = cardFixture(true, "https://studio.test/api/a2a/helper");

const answering: AgentExecutor = {
  async execute(ctx: RequestContext, bus: ExecutionEventBus) {
    bus.publish(
      AgentEvent.task(
        taskFixture({
          id: ctx.taskId,
          contextId: ctx.contextId,
          status: taskStatus(TaskState.TASK_STATE_SUBMITTED),
        }),
      ),
    );
    bus.publish(
      AgentEvent.statusUpdate({
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        status: taskStatus(TaskState.TASK_STATE_COMPLETED),
        metadata: undefined,
      }),
    );
    bus.finished();
  },
  async cancelTask() {},
};

function storeWith(tasks: Record<string, Task>): TaskStore {
  return fakeTaskStore({
    load: async (id) => tasks[id],
    save: async (saved) => {
      tasks[saved.id] = saved;
    },
  });
}

function handler(
  store: TaskStore,
  options: { signal?: AbortSignal; acceptImageUrls?: boolean } = {},
) {
  return new ProjectRequestHandler(store, options, CARD, store, answering);
}

function request(parts = [textPart("hi")], taskId = ""): SendMessageRequest {
  return {
    tenant: "test",
    message: { ...messageFixture("hi", taskId ? { taskId } : {}), parts },
    configuration: undefined,
    metadata: undefined,
  };
}

describe("ProjectRequestHandler — what it admits", () => {
  it("round-trips native A2A 1.0 JSON-RPC through the SDK transport", async () => {
    const transport = new JsonRpcTransportHandler(handler(storeWith({})));
    const response = await transport.handle(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "SendMessage",
        params: SendMessageRequestCodec.toJSON(request()),
      }),
      TEST_CALL_CONTEXT,
    );
    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        task: {
          status: { state: "TASK_STATE_COMPLETED" },
        },
      },
    });

    const legacy = await transport.handle(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "message/send", params: {} }),
      TEST_CALL_CONTEXT,
    );
    expect(legacy).toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32601 },
    });
  });

  it("names unsupported parts and applies the shared image bounds", () => {
    expect(unsupportedPart(textPart("x"))).toBeNull();
    expect(
      unsupportedPart({
        content: { $case: "raw", value: Buffer.from("AAAA", "base64") },
        mediaType: "image/png",
        filename: "",
        metadata: undefined,
      }),
    ).toBeNull();
    expect(
      unsupportedPart({
        content: { $case: "raw", value: Buffer.from("AAAA", "base64") },
        mediaType: "image/svg+xml",
        filename: "",
        metadata: undefined,
      }),
    ).toBe("file part of type image/svg+xml");
    expect(
      unsupportedPart({
        content: { $case: "raw", value: Buffer.alloc(5 * 1024 * 1024 + 1) },
        mediaType: "image/png",
        filename: "",
        metadata: undefined,
      }),
    ).toBe("image larger than 5MB");
    expect(
      unsupportedPart({
        content: { $case: "url", value: "https://x/p.png" },
        mediaType: "image/png",
        filename: "",
        metadata: undefined,
      }),
    ).toBe("image file part by URL");
    expect(
      unsupportedPart({
        content: { $case: "url", value: "http://x/p.png" },
        mediaType: "image/png",
        filename: "",
        metadata: undefined,
      }),
    ).toBe("image file part by URL");
    expect(
      unsupportedPart({
        content: { $case: "data", value: { a: 1 } },
        mediaType: "application/json",
        filename: "",
        metadata: undefined,
      }),
    ).toBe("data part");
  });

  it("refuses more pictures than a turn may carry", async () => {
    const parts = Array.from({ length: 5 }, () => ({
      content: { $case: "raw" as const, value: Buffer.from("AAAA", "base64") },
      mediaType: "image/png",
      filename: "",
      metadata: undefined,
    }));
    await expect(
      handler(storeWith({})).sendMessage(request(parts), TEST_CALL_CONTEXT),
    ).rejects.toMatchObject({
      name: ContentTypeNotSupportedError.name,
      message: expect.stringContaining("at most 4 images"),
    });
  });

  it("refuses a data part with ContentTypeNotSupported", async () => {
    const data = {
      content: { $case: "data" as const, value: { a: 1 } },
      mediaType: "application/json",
      filename: "",
      metadata: undefined,
    };
    await expect(
      handler(storeWith({})).sendMessage(request([data]), TEST_CALL_CONTEXT),
    ).rejects.toBeInstanceOf(ContentTypeNotSupportedError);
  });

  it("refuses URL image parts for every project", async () => {
    const urlPart = {
      content: { $case: "url" as const, value: "https://x/p.png" },
      mediaType: "image/png",
      filename: "",
      metadata: undefined,
    };
    await expect(
      handler(storeWith({})).sendMessage(request([urlPart]), TEST_CALL_CONTEXT),
    ).rejects.toMatchObject({
      name: ContentTypeNotSupportedError.name,
      message: expect.stringContaining("image file part by URL"),
    });
  });

  it("refuses a message that would continue a live task", async () => {
    const store = storeWith({
      t1: taskFixture({ status: taskStatus(TaskState.TASK_STATE_WORKING) }),
    });
    await expect(handler(store).sendMessage(request(undefined, "t1"), TEST_CALL_CONTEXT)).rejects.toMatchObject({
      name: RequestMalformedError.name,
      message: expect.stringContaining("keep contextId c1"),
    });
  });

  it("lets a valid message through to the SDK execution path", async () => {
    const result = await handler(storeWith({})).sendMessage(request(), TEST_CALL_CONTEXT);
    expect("id" in result ? result.status?.state : undefined).toBe(TaskState.TASK_STATE_COMPLETED);
  });
});

describe("ProjectRequestHandler — resubscribe follows the store", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("replays the snapshot, changed artifact, closed artifact, and terminal status", async () => {
    vi.useFakeTimers();
    const tasks: Record<string, Task> = {
      t1: taskFixture({ status: taskStatus(TaskState.TASK_STATE_WORKING) }),
    };
    const events: unknown[] = [];
    const drain = (async () => {
      for await (const event of handler(storeWith(tasks)).resubscribe(
        { tenant: "test", id: "t1" },
        TEST_CALL_CONTEXT,
      )) {
        events.push(event);
      }
    })();
    await vi.advanceTimersByTimeAsync(2_000);
    tasks.t1 = taskFixture({
      status: taskStatus(TaskState.TASK_STATE_COMPLETED),
      artifacts: [artifact("result", [textPart("done")])],
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await drain;

    const payloads = events.map((event) =>
      (event as { payload?: { $case?: string; value?: unknown } }).payload,
    );
    expect(payloads.map((payload) => payload?.$case)).toEqual([
      "task",
      "artifactUpdate",
      "artifactUpdate",
      "statusUpdate",
    ]);
    expect(payloads[1]?.value).toMatchObject({ artifact: { artifactId: "result" }, append: false });
    expect(payloads[2]?.value).toMatchObject({
      artifact: { artifactId: "result" },
      append: false,
      lastChunk: true,
    });
    expect(payloads[3]?.value).toMatchObject({
      status: { state: TaskState.TASK_STATE_COMPLETED },
    });
  });

  it("replays non-terminal status changes while following the task", async () => {
    vi.useFakeTimers();
    const tasks: Record<string, Task> = {
      t1: taskFixture({ status: taskStatus(TaskState.TASK_STATE_WORKING) }),
    };
    const stream = handler(storeWith(tasks)).resubscribe(
      { tenant: "test", id: "t1" },
      TEST_CALL_CONTEXT,
    );
    await stream.next();
    const update = stream.next();
    tasks.t1 = taskFixture({ status: taskStatus(TaskState.TASK_STATE_INPUT_REQUIRED) });
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(update).resolves.toMatchObject({
      value: {
        payload: {
          $case: "statusUpdate",
          value: { status: { state: TaskState.TASK_STATE_INPUT_REQUIRED } },
        },
      },
    });
    await stream.return(undefined);
  });

  it("stops polling when the reader leaves", async () => {
    vi.useFakeTimers();
    const loads: number[] = [];
    const working = taskFixture({ status: taskStatus(TaskState.TASK_STATE_WORKING) });
    const store = fakeTaskStore({
      load: async () => {
        loads.push(1);
        return working;
      },
    });
    const controller = new AbortController();
    const events: unknown[] = [];
    const drain = (async () => {
      for await (const event of handler(store, { signal: controller.signal }).resubscribe(
        { tenant: "test", id: "t1" },
        TEST_CALL_CONTEXT,
      )) {
        events.push(event);
      }
    })();
    await vi.advanceTimersByTimeAsync(2_000);
    controller.abort();
    await drain;
    const after = loads.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(loads.length).toBe(after);
    expect(events).toHaveLength(1);
  });

  it("reports a task that never settles instead of closing silently", async () => {
    vi.useFakeTimers();
    const stream = handler(
      storeWith({ t1: taskFixture({ status: taskStatus(TaskState.TASK_STATE_WORKING) }) }),
    ).resubscribe({ tenant: "test", id: "t1" }, TEST_CALL_CONTEXT);
    await stream.next();
    const pending = stream.next().then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
    await expect(pending).resolves.toMatchObject({ message: expect.stringContaining("did not settle") });
  });

  it("answers a missing task with TaskNotFound", async () => {
    const refused = await handler(storeWith({}))
      .resubscribe({ tenant: "test", id: "nope" }, TEST_CALL_CONTEXT)
      .next()
      .then(() => null, (error: unknown) => error);
    expect(refused).toBeInstanceOf(TaskNotFoundError);
  });

  it("refuses resubscription to a terminal task", async () => {
    const refused = await handler(
      storeWith({ t1: taskFixture({ status: taskStatus(TaskState.TASK_STATE_COMPLETED) }) }),
    )
      .resubscribe({ tenant: "test", id: "t1" }, TEST_CALL_CONTEXT)
      .next()
      .then(() => null, (error: unknown) => error);
    expect(refused).toBeInstanceOf(UnsupportedOperationError);
  });
});
