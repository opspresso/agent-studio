import { TaskState, type Task } from "@a2a-js/sdk";
import { ServerCallContext } from "@a2a-js/sdk/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeStore } from "./fakeStore";
import { agentMessage, artifact, rawPart, taskStatus, textPart } from "@/domain/a2a/protocol";
import { keys } from "@/infrastructure/db/keys";

vi.mock("@/infrastructure/db/store", async () => (await import("./fakeStore")).createFakeStore());
const store = (await import("@/infrastructure/db/store")) as unknown as FakeStore;

const { A2A_TASK_SCAN_PAGE_SIZE, createA2aTaskStore } = await import(
  "@/infrastructure/a2a/taskStore"
);

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
  store.rows.clear();
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
    // The scope is `${tenant}:${user}`, and the purge is a periodic sweep — a
    // row past its TTL can still be there and must read as gone.
    store.seed([
      {
        ...keys.a2aTask("proj-a", "tenant-a:alice", "t1"),
        state: TaskState.TASK_STATE_COMPLETED,
        task: makeTask("t1", TaskState.TASK_STATE_COMPLETED),
        expiresAt: 1,
      },
    ]);
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
    // Only a lost precondition is the losing side of a race; any other failure
    // of the write is the caller's to see.
    vi.spyOn(store, "putItem").mockRejectedValueOnce(new Error("network partition"));
    await expect(
      createA2aTaskStore("proj-a").save(makeTask("t1", TaskState.TASK_STATE_WORKING), ALICE),
    ).rejects.toThrow(/network partition/);
    expect(store.rows.size).toBe(0);
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
    // Read through Buffer.from, as the small-part case does: the store keeps
    // the task as JSON, so the bytes come back in Buffer's JSON form.
    expect(part?.content?.$case === "raw" ? Buffer.from(part.content.value).byteLength : -1).toBe(0);
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

  it("reads a large task partition in bounded database pages", async () => {
    const taskCount = A2A_TASK_SCAN_PAGE_SIZE * 2 + 5;
    store.seed(
      Array.from({ length: taskCount }, (_, index) => {
        const id = `t${index.toString().padStart(3, "0")}`;
        return {
          ...keys.a2aTask("proj-a", "tenant-a:alice", id),
          state: TaskState.TASK_STATE_COMPLETED,
          task: makeTask(id, TaskState.TASK_STATE_COMPLETED),
        };
      }),
    );
    const query = vi.spyOn(store, "queryItems");

    const page = await createA2aTaskStore("proj-a").list(
      {
        tenant: "tenant-a",
        contextId: "ctx-1",
        status: TaskState.TASK_STATE_UNSPECIFIED,
        pageSize: 100,
        pageToken: "",
        historyLength: 0,
        statusTimestampAfter: undefined,
        includeArtifacts: false,
      },
      ALICE,
    );

    expect(page.totalSize).toBe(taskCount);
    expect(page.tasks).toHaveLength(100);
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls.every(([input]) => input.limit === A2A_TASK_SCAN_PAGE_SIZE)).toBe(true);
    expect(query.mock.calls[1]?.[0].after).toBe("TASK#t099");
    expect(query.mock.calls[2]?.[0].after).toBe("TASK#t199");
    query.mockRestore();
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
