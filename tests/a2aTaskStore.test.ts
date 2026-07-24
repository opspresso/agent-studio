import type { Task, TaskState } from "@a2a-js/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Faithful in-memory stand-in for the single table: it stores items by PK/SK and
 * evaluates the adapter's terminal-state condition exactly like DynamoDB would,
 * so the terminal-no-regress guarantee is tested end-to-end (not just mocked).
 */
const { store, behavior, fakeClient } = vi.hoisted(() => {
  const store = new Map<string, Record<string, unknown>>();
  const behavior = { boom: false };
  const keyOf = (k: { PK: string; SK: string }) => `${k.PK}|${k.SK}`;
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

function makeTask(id: string, state: TaskState): Task {
  return {
    kind: "task",
    id,
    contextId: "ctx-1",
    status: { state, timestamp: "2026-01-01T00:00:00.000Z" },
    history: [],
  };
}

beforeEach(() => {
  store.clear();
  behavior.boom = false;
});

describe("createA2aTaskStore", () => {
  it("round-trips a saved task", async () => {
    const s = createA2aTaskStore("proj-a");
    await s.save(makeTask("t1", "working"));
    const loaded = await s.load("t1");
    expect(loaded?.id).toBe("t1");
    expect(loaded?.status.state).toBe("working");
  });

  it("isolates tasks by project (another project's store cannot load it)", async () => {
    await createA2aTaskStore("proj-a").save(makeTask("shared-id", "working"));
    expect(await createA2aTaskStore("proj-b").load("shared-id")).toBeUndefined();
  });

  it("returns undefined for a non-existent task", async () => {
    expect(await createA2aTaskStore("proj-a").load("missing")).toBeUndefined();
  });

  it("treats an expired row as absent (TTL read filter)", async () => {
    // Physical TTL purge lags, so reads must drop already-expired rows.
    store.set("A2ATASK#proj-a#t1|META", {
      PK: "A2ATASK#proj-a#t1",
      SK: "META",
      state: "completed",
      task: makeTask("t1", "completed"),
      expiresAt: 1, // 1970 — long past
    });
    expect(await createA2aTaskStore("proj-a").load("t1")).toBeUndefined();
  });

  it("allows non-terminal progression", async () => {
    const s = createA2aTaskStore("proj-a");
    await s.save(makeTask("t1", "submitted"));
    await s.save(makeTask("t1", "working"));
    await s.save(makeTask("t1", "input-required"));
    expect((await s.load("t1"))?.status.state).toBe("input-required");
  });

  it("never overwrites a terminal task (no regression)", async () => {
    const s = createA2aTaskStore("proj-a");
    await s.save(makeTask("t1", "completed"));
    await s.save(makeTask("t1", "working")); // must be a no-op
    expect((await s.load("t1"))?.status.state).toBe("completed");
  });

  it("resolves a complete/cancel race to the first terminal transition", async () => {
    const s = createA2aTaskStore("proj-a");
    await s.save(makeTask("t1", "working"));
    await s.save(makeTask("t1", "canceled")); // cancel lands first
    // The completion loop finishes later and tries to persist — swallowed.
    await expect(s.save(makeTask("t1", "completed"))).resolves.toBeUndefined();
    expect((await s.load("t1"))?.status.state).toBe("canceled");
  });

  it("propagates non-conditional write errors", async () => {
    behavior.boom = true;
    await expect(createA2aTaskStore("proj-a").save(makeTask("t1", "working"))).rejects.toThrow(
      /network partition/,
    );
  });

  it("preserves small inline file bytes", async () => {
    const s = createA2aTaskStore("proj-a");
    const task = makeTask("t1", "completed");
    task.artifacts = [
      { artifactId: "image", parts: [{ kind: "file", file: { bytes: "AAAA", mimeType: "image/png" } }] },
    ];
    await s.save(task);
    const loaded = await s.load("t1");
    const part = loaded?.artifacts?.[0]?.parts?.[0];
    expect(part?.kind === "file" && "bytes" in part.file && part.file.bytes).toBe("AAAA");
  });

  it("drops oversized inline file bytes to stay under the item limit", async () => {
    const s = createA2aTaskStore("proj-a");
    const task = makeTask("t1", "completed");
    task.artifacts = [
      {
        artifactId: "image",
        parts: [{ kind: "file", file: { bytes: "A".repeat(400_000), mimeType: "image/png" } }],
      },
    ];
    await s.save(task);
    const loaded = await s.load("t1");
    const part = loaded?.artifacts?.[0]?.parts?.[0];
    expect(part?.kind === "file" && "bytes" in part.file && part.file.bytes).toBe("");
    // Non-byte metadata survives.
    expect(part?.kind === "file" && part.file.mimeType).toBe("image/png");
    expect(loaded?.status.state).toBe("completed");
  });

  it("degrades to state + metadata when non-byte content exceeds the item limit", async () => {
    // History/text with no inline file bytes can still blow the 400KB item
    // limit; stripping bytes alone would leave it oversized, so the store must
    // drop history/artifacts and keep the task retrievable rather than throw.
    const s = createA2aTaskStore("proj-a");
    const task = makeTask("t1", "completed");
    task.history = [
      { kind: "message", role: "agent", messageId: "m1", parts: [{ kind: "text", text: "x".repeat(400_000) }] },
    ];
    task.artifacts = [{ artifactId: "a1", parts: [{ kind: "text", text: "small" }] }];

    await expect(s.save(task)).resolves.toBeUndefined();

    const loaded = await s.load("t1");
    // State + metadata stay retrievable; the bulky collections are dropped.
    expect(loaded?.status.state).toBe("completed");
    expect(loaded?.id).toBe("t1");
    expect(loaded?.contextId).toBe("ctx-1");
    expect(loaded?.history).toBeUndefined();
    expect(loaded?.artifacts).toBeUndefined();
  });
});
