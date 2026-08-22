import { TaskState, type Task } from "@a2a-js/sdk";
import { ServerCallContext } from "@a2a-js/sdk/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentMessage, artifact, rawPart, taskStatus, textPart } from "@/domain/a2a/protocol";

const { store, behavior, fakeClient } = vi.hoisted(() => {
  const store = new Map<string, Record<string, unknown>>();
  const behavior = { boom: false };
  const keyOf = (key: { PK: string; SK: string }) => `${key.PK}|${key.SK}`;
  const fakeClient = {
    async send(command: { input: Record<string, unknown> }) {
      const input = command.input;
      if (input.Item) {
        if (behavior.boom) {
          throw new Error("network partition");
        }
        const item = input.Item as Record<string, unknown> & { PK: string; SK: string };
        const existing = store.get(keyOf(item));
        if (input.ConditionExpression && existing) {
          const terminal = Object.values(input.ExpressionAttributeValues ?? {});
          if (terminal.includes(existing.state)) {
            throw Object.assign(new Error("conditional"), {
              name: "ConditionalCheckFailedException",
            });
          }
        }
        store.set(keyOf(item), item);
        return {};
      }
      if (input.Key) {
        return { Item: store.get(keyOf(input.Key as { PK: string; SK: string })) };
      }
      if (input.KeyConditionExpression) {
        const values = input.ExpressionAttributeValues as Record<string, string>;
        return {
          Items: [...store.values()].filter(
            (item) =>
              item.PK === values[":pk"] &&
              typeof item.SK === "string" &&
              item.SK.startsWith(values[":task"] ?? ""),
          ),
        };
      }
      return {};
    },
  };
  return { store, behavior, fakeClient };
});

vi.mock("@/infrastructure/db/client", () => ({
  getDocumentClient: () => fakeClient,
  getTableName: () => "test-table",
}));

const { createA2aTaskStore } = await import("@/infrastructure/a2a/taskStore");

const ALICE = new ServerCallContext({
  tenant: "tenant-a",
  user: { isAuthenticated: true, userName: "alice" },
});
const BOB = new ServerCallContext({
  tenant: "tenant-a",
  user: { isAuthenticated: true, userName: "bob" },
});

function makeTask(id: string, state: TaskState): Task {
  return {
    id,
    contextId: "ctx-1",
    status: taskStatus(state),
    artifacts: [],
    history: [],
    metadata: undefined,
  };
}

beforeEach(() => {
  store.clear();
  behavior.boom = false;
});

describe("createA2aTaskStore", () => {
  it("round-trips a saved task", async () => {
    const tasks = createA2aTaskStore("proj-a");
    await tasks.save(makeTask("t1", TaskState.TASK_STATE_WORKING), ALICE);
    const loaded = await tasks.load("t1", ALICE);
    expect(loaded?.id).toBe("t1");
    expect(loaded?.status?.state).toBe(TaskState.TASK_STATE_WORKING);
  });

  it("isolates tasks by project and authenticated caller", async () => {
    await createA2aTaskStore("proj-a").save(
      makeTask("shared-id", TaskState.TASK_STATE_WORKING),
      ALICE,
    );
    expect(await createA2aTaskStore("proj-b").load("shared-id", ALICE)).toBeUndefined();
    expect(await createA2aTaskStore("proj-a").load("shared-id", BOB)).toBeUndefined();
  });

  it("returns undefined for a missing or expired task", async () => {
    const tasks = createA2aTaskStore("proj-a");
    expect(await tasks.load("missing", ALICE)).toBeUndefined();
    store.set("A2ATASK#proj-a#tenant-a%3Aalice|TASK#t1", {
      PK: "A2ATASK#proj-a#tenant-a%3Aalice",
      SK: "TASK#t1",
      state: TaskState.TASK_STATE_COMPLETED,
      task: makeTask("t1", TaskState.TASK_STATE_COMPLETED),
      expiresAt: 1,
    });
    expect(await tasks.load("t1", ALICE)).toBeUndefined();
  });

  it("allows non-terminal progression", async () => {
    const tasks = createA2aTaskStore("proj-a");
    await tasks.save(makeTask("t1", TaskState.TASK_STATE_SUBMITTED), ALICE);
    await tasks.save(makeTask("t1", TaskState.TASK_STATE_WORKING), ALICE);
    await tasks.save(makeTask("t1", TaskState.TASK_STATE_INPUT_REQUIRED), ALICE);
    expect((await tasks.load("t1", ALICE))?.status?.state).toBe(
      TaskState.TASK_STATE_INPUT_REQUIRED,
    );
  });

  it("never overwrites a terminal task", async () => {
    const tasks = createA2aTaskStore("proj-a");
    await tasks.save(makeTask("t1", TaskState.TASK_STATE_COMPLETED), ALICE);
    await tasks.save(makeTask("t1", TaskState.TASK_STATE_WORKING), ALICE);
    expect((await tasks.load("t1", ALICE))?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
  });

  it("resolves a complete/cancel race to the first terminal transition", async () => {
    const tasks = createA2aTaskStore("proj-a");
    await tasks.save(makeTask("t1", TaskState.TASK_STATE_WORKING), ALICE);
    await tasks.save(makeTask("t1", TaskState.TASK_STATE_CANCELED), ALICE);
    await expect(
      tasks.save(makeTask("t1", TaskState.TASK_STATE_COMPLETED), ALICE),
    ).resolves.toBeUndefined();
    expect((await tasks.load("t1", ALICE))?.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
  });

  it("propagates non-conditional write errors", async () => {
    behavior.boom = true;
    await expect(
      createA2aTaskStore("proj-a").save(makeTask("t1", TaskState.TASK_STATE_WORKING), ALICE),
    ).rejects.toThrow(/network partition/);
  });

  it("preserves small raw parts", async () => {
    const tasks = createA2aTaskStore("proj-a");
    const task = makeTask("t1", TaskState.TASK_STATE_COMPLETED);
    task.artifacts = [artifact("image", [rawPart("AAAA", "image/png")])];
    await tasks.save(task, ALICE);
    const part = (await tasks.load("t1", ALICE))?.artifacts[0]?.parts[0];
    expect(part?.content?.$case === "raw" ? Buffer.from(part.content.value).toString("base64") : "").toBe(
      "AAAA",
    );
  });

  it("drops oversized raw bytes before dropping task state", async () => {
    const tasks = createA2aTaskStore("proj-a");
    const task = makeTask("t1", TaskState.TASK_STATE_COMPLETED);
    task.artifacts = [artifact("image", [rawPart("A".repeat(400_000), "image/png")])];
    await tasks.save(task, ALICE);
    const loaded = await tasks.load("t1", ALICE);
    const part = loaded?.artifacts[0]?.parts[0];
    expect(part?.content?.$case === "raw" ? part.content.value.byteLength : -1).toBe(0);
    expect(part?.mediaType).toBe("image/png");
    expect(loaded?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
  });

  it("drops history before artifacts when the item is too large", async () => {
    const tasks = createA2aTaskStore("proj-a");
    const task = makeTask("t1", TaskState.TASK_STATE_COMPLETED);
    task.history = [agentMessage("m1", "ctx-1", "t1", "x".repeat(400_000))];
    task.artifacts = [artifact("a1", [textPart("small")])];
    await tasks.save(task, ALICE);
    const loaded = await tasks.load("t1", ALICE);
    expect(loaded?.history).toEqual([]);
    expect(loaded?.artifacts).toEqual([artifact("a1", [textPart("small")])]);
  });

  it("degrades to state and metadata when artifacts alone exceed the item limit", async () => {
    const tasks = createA2aTaskStore("proj-a");
    const task = makeTask("t1", TaskState.TASK_STATE_COMPLETED);
    task.artifacts = [artifact("a1", [textPart("x".repeat(400_000))])];
    await tasks.save(task, ALICE);
    const loaded = await tasks.load("t1", ALICE);
    expect(loaded?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(loaded?.history).toEqual([]);
    expect(loaded?.artifacts).toEqual([]);
  });

  it("lists only the caller's tasks with filtering, projection, and pagination", async () => {
    const tasks = createA2aTaskStore("proj-a");
    const first = makeTask("t1", TaskState.TASK_STATE_COMPLETED);
    first.status = { ...taskStatus(TaskState.TASK_STATE_COMPLETED), timestamp: "2026-01-01T00:00:00Z" };
    first.artifacts = [artifact("a1", [textPart("one")])];
    first.history = [agentMessage("m1", "ctx-1", "t1", "old"), agentMessage("m2", "ctx-1", "t1", "new")];
    const second = makeTask("t2", TaskState.TASK_STATE_COMPLETED);
    second.status = { ...taskStatus(TaskState.TASK_STATE_COMPLETED), timestamp: "2026-01-02T00:00:00Z" };
    second.artifacts = [artifact("a2", [textPart("two")])];
    second.history = [agentMessage("m3", "ctx-1", "t2", "second")];
    await tasks.save(first, ALICE);
    await tasks.save(second, ALICE);
    await tasks.save(makeTask("bob", TaskState.TASK_STATE_COMPLETED), BOB);

    const page = await tasks.list(
      {
        tenant: "tenant-a",
        contextId: "ctx-1",
        status: TaskState.TASK_STATE_COMPLETED,
        pageSize: 1,
        pageToken: "",
        historyLength: 1,
        statusTimestampAfter: "2026-01-01T00:00:00Z",
        includeArtifacts: false,
      },
      ALICE,
    );
    expect(page.totalSize).toBe(2);
    expect(page.tasks.map((task) => task.id)).toEqual(["t2"]);
    expect(page.tasks[0]?.artifacts).toEqual([]);
    expect(page.tasks[0]?.history).toHaveLength(1);
    expect(page.nextPageToken).not.toBe("");

    // A newer task arriving between pages must not shift an offset and make
    // the last task from page one appear again on page two.
    const newer = makeTask("t3", TaskState.TASK_STATE_COMPLETED);
    newer.status = {
      ...taskStatus(TaskState.TASK_STATE_COMPLETED),
      timestamp: "2026-01-03T00:00:00Z",
    };
    await tasks.save(newer, ALICE);

    const next = await tasks.list(
      {
        tenant: "tenant-a",
        contextId: "ctx-1",
        status: TaskState.TASK_STATE_COMPLETED,
        pageSize: 1,
        pageToken: page.nextPageToken,
        historyLength: 0,
        statusTimestampAfter: undefined,
        includeArtifacts: true,
      },
      ALICE,
    );
    expect(next.tasks.map((task) => task.id)).toEqual(["t1"]);
    expect(next.tasks[0]?.artifacts).toHaveLength(1);
    expect(next.tasks[0]?.history).toEqual([]);
  });

  it("rejects invalid ListTasks bounds and page tokens", async () => {
    const tasks = createA2aTaskStore("proj-a");
    const base = {
      tenant: "tenant-a",
      contextId: "",
      status: TaskState.TASK_STATE_UNSPECIFIED,
      pageToken: "",
      historyLength: undefined,
      statusTimestampAfter: undefined,
      includeArtifacts: false,
    };
    await expect(tasks.list({ ...base, pageSize: 0 }, ALICE)).rejects.toThrow(/pageSize/);
    await expect(tasks.list({ ...base, pageSize: 10, pageToken: "invalid" }, ALICE)).rejects.toThrow(
      /pageToken/,
    );
    await expect(tasks.list({ ...base, pageSize: 10, historyLength: -1 }, ALICE)).rejects.toThrow(
      /historyLength/,
    );
  });
});
