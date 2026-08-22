import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentCard, Message, Task } from "@a2a-js/sdk";
import type { AgentExecutor, ExecutionEventBus, RequestContext, TaskStore } from "@a2a-js/sdk/server";
import { A2AError } from "@a2a-js/sdk/server";
import { ProjectRequestHandler, unsupportedPart } from "@/application/a2a/requestHandler";

const handler = (store: TaskStore, options: { signal?: AbortSignal } = {}) =>
  new ProjectRequestHandler(store, options, CARD, store, answering);

const CARD: AgentCard = {
  protocolVersion: "0.3.0",
  name: "Helper",
  description: "",
  url: "https://studio.test/api/a2a/helper",
  version: "v1",
  capabilities: { streaming: true },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [],
};

function message(taskId?: string): Message {
  return {
    kind: "message",
    messageId: "m1",
    role: "user",
    parts: [{ kind: "text", text: "hi" }],
    ...(taskId ? { taskId } : {}),
  };
}

function task(id: string, state: Task["status"]["state"], artifacts: Task["artifacts"] = []): Task {
  return { kind: "task", id, contextId: "c1", status: { state }, artifacts };
}

/** An executor that answers at once, so the SDK's own path can run to the end. */
const answering: AgentExecutor = {
  async execute(ctx: RequestContext, bus: ExecutionEventBus) {
    if (!ctx.task) {
      bus.publish({ kind: "task", id: ctx.taskId, contextId: ctx.contextId, status: { state: "submitted" } });
    }
    bus.publish({
      kind: "status-update",
      taskId: ctx.taskId,
      contextId: ctx.contextId,
      final: true,
      status: { state: "completed" },
    });
    bus.finished();
  },
  async cancelTask() {},
};

function storeWith(tasks: Record<string, Task>): TaskStore {
  return {
    load: async (id) => tasks[id],
    save: async (saved) => {
      tasks[saved.id] = saved;
    },
  };
}

describe("ProjectRequestHandler — what it admits", () => {
  it("names the parts it cannot read, and bounds a picture like every other surface", () => {
    expect(unsupportedPart({ kind: "text", text: "x" })).toBeNull();
    expect(unsupportedPart({ kind: "file", file: { bytes: "AAAA", mimeType: "image/png" } })).toBeNull();
    expect(unsupportedPart({ kind: "file", file: { bytes: "AAAA", mimeType: "image/svg+xml" } })).toBe(
      "file part of type image/svg+xml",
    );
    expect(
      unsupportedPart({ kind: "file", file: { bytes: "A".repeat(8 * 1024 * 1024), mimeType: "image/png" } }),
    ).toBe("image larger than 5MB");
    expect(unsupportedPart({ kind: "file", file: { uri: "https://x/p.png", mimeType: "image/png" } })).toBeNull();
    expect(unsupportedPart({ kind: "file", file: { uri: "http://x/p.png", mimeType: "image/png" } })).toBe(
      "file part by a non-https uri",
    );
    expect(unsupportedPart({ kind: "file", file: { bytes: "AAAA", mimeType: "application/pdf" } })).toBe(
      "file part of type application/pdf",
    );
    expect(unsupportedPart({ kind: "data", data: { a: 1 } })).toBe("data part");
  });

  it("refuses more pictures than a turn may carry", async () => {
    const parts = Array.from({ length: 5 }, () => ({
      kind: "file" as const,
      file: { bytes: "AAAA", mimeType: "image/png" },
    }));
    const refused = await handler(storeWith({}))
      .sendMessage({ message: { ...message(), parts } })
      .then(() => null, (error: unknown) => error);
    expect((refused as A2AError).code).toBe(-32005);
    expect((refused as A2AError).message).toContain("at most 4 images");
  });

  it("refuses a data part with the protocol's ContentTypeNotSupported error", async () => {
    const refused = await handler(storeWith({}))
      .sendMessage({ message: { ...message(), parts: [{ kind: "data", data: { a: 1 } }] } })
      .then(() => null, (error: unknown) => error);
    expect(refused).toBeInstanceOf(A2AError);
    expect((refused as A2AError).code).toBe(-32005);
  });

  it("refuses a message that would continue a task still working", async () => {
    const store = storeWith({ t1: task("t1", "working") });
    const refused = await handler(store).sendMessage({ message: message("t1") }).then(() => null, (error: unknown) => error);
    expect(refused).toBeInstanceOf(A2AError);
    expect((refused as A2AError).code).toBe(-32602);
    expect((refused as A2AError).message).toContain("keep contextId c1");
  });

  it("lets a message through to the SDK's own path otherwise", async () => {
    const store = storeWith({});
    const result = await handler(store).sendMessage({ message: message() });
    expect(result.kind).toBe("task");
    expect((result as Task).status.state).toBe("completed");
  });
});

describe("ProjectRequestHandler — resubscribe follows the store", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("replays the snapshot, each artifact as it lands, and the terminal status", async () => {
    vi.useFakeTimers();
    const tasks: Record<string, Task> = { t1: task("t1", "working") };
    const store = storeWith(tasks);
    const events: unknown[] = [];
    const drain = (async () => {
      for await (const event of handler(store).resubscribe({ id: "t1" })) {
        events.push(event);
      }
    })();
    await vi.advanceTimersByTimeAsync(2_000);
    // Another instance finished the run between polls.
    tasks.t1 = task("t1", "completed", [{ artifactId: "result", parts: [{ kind: "text", text: "done" }] }]);
    await vi.advanceTimersByTimeAsync(2_000);
    await drain;
    expect(events.map((event) => (event as { kind: string }).kind)).toEqual([
      "task",
      "artifact-update",
      "artifact-update",
      "status-update",
    ]);
    expect(events[1]).toMatchObject({ artifact: { artifactId: "result", parts: [{ kind: "text", text: "done" }] }, append: false });
    // Closed as the protocol closes one, whether or not the last change landed in the terminal poll.
    expect(events[2]).toMatchObject({ artifact: { artifactId: "result", parts: [] }, append: true, lastChunk: true });
    expect(events[3]).toMatchObject({ final: true, status: { state: "completed" } });
  });

  it("stops polling the moment the reader leaves", async () => {
    vi.useFakeTimers();
    const loads: number[] = [];
    const store: TaskStore = {
      load: async () => {
        loads.push(1);
        return task("t1", "working");
      },
      save: async () => {},
    };
    const controller = new AbortController();
    const events: unknown[] = [];
    const drain = (async () => {
      for await (const event of handler(store, { signal: controller.signal }).resubscribe({ id: "t1" })) {
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

  it("reports a task that never settles as an error rather than closing in silence", async () => {
    vi.useFakeTimers();
    const store = storeWith({ t1: task("t1", "working") });
    const stream = handler(store).resubscribe({ id: "t1" });
    await stream.next();
    const pending = stream.next().then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
    const error = await pending;
    expect(error).toBeInstanceOf(A2AError);
    expect((error as A2AError).message).toContain("did not settle");
  });

  it("answers a task it does not hold with TaskNotFound", async () => {
    const store = storeWith({});
    const refused = await handler(store)
      .resubscribe({ id: "nope" })
      .next()
      .then(() => null, (error: unknown) => error);
    expect((refused as A2AError).code).toBe(-32001);
  });
});
