import { describe, expect, it, vi } from "vitest";
import {
  admitDelivery,
  executeDelivery,
  payloadInput,
  triggerActor,
  type TriggerRunnerDeps,
} from "@/application/trigger/runTrigger";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import type { EngineChunk } from "@/domain/llm/types";
import type { Project, Version } from "@/domain/project/types";
import type { TriggerRepository } from "@/domain/trigger/repository";
import type { TriggerRun, WebhookTrigger } from "@/domain/trigger/types";
import type { RunSlot, RunSlotRepository } from "@/domain/execution/runSlot";

process.env.AES_ENCRYPTION_KEY ??= Buffer.alloc(32, 3).toString("base64");

const SECRET = "asw_test-secret-value";

const project: Project = {
  name: "p",
  displayName: "P",
  description: "",
  projectType: "agent",
  ownerEmail: "owner@example.com",
  publishedVersion: "v1",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const version: Version = {
  projectName: "p",
  versionName: "v1",
  systemPrompt: "",
  userPromptTemplate: "",
  model: "openai/gpt-5-mini",
  parameters: { piiFiltering: false },
  mcpList: [],
  skillList: [],
  subagentList: [],
  createdAt: "2026-01-01T00:00:00Z",
};

function trigger(overrides: Partial<WebhookTrigger> = {}): WebhookTrigger {
  return {
    projectName: "p",
    triggerId: "nightly",
    kind: "webhook",
    description: "",
    enabled: true,
    secret: secretCipher.encrypt(SECRET),
    payloadMode: "message",
    allowConcurrent: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function memorySlots() {
  const held = new Map<string, number>();
  const repo: RunSlotRepository = {
    async acquire(actor, limit, leaseUntilSeconds) {
      const now = Math.floor(Date.now() / 1000);
      const lease = held.get(actor);
      if (lease !== undefined && lease > now) {
        return limit > 1 ? { index: 1 } : null;
      }
      held.set(actor, leaseUntilSeconds);
      return { index: 0 };
    },
    async release(actor, _slot: RunSlot) {
      held.delete(actor);
    },
  };
  return repo;
}

interface Fixture {
  deps: TriggerRunnerDeps;
  rows: TriggerRun[];
  claimed: Set<string>;
  runs: Array<{ variables?: Record<string, string>; message?: string; actorKind: string }>;
}

function fixture(
  opts: {
    stored?: WebhookTrigger | null;
    published?: Version | null;
    chunks?: EngineChunk[];
    runThrows?: Error;
  } = {},
): Fixture {
  const rows: TriggerRun[] = [];
  const claimed = new Set<string>();
  const runs: Fixture["runs"] = [];
  const triggers: TriggerRepository = {
    get: async () => (opts.stored === undefined ? trigger() : opts.stored),
    listByProject: async () => [],
    listSchedules: async () => [],
    create: async () => {},
    put: async () => {},
    delete: async () => {},
    async claimIdempotencyKey(_p, _t, key) {
      if (claimed.has(key)) {
        return false;
      }
      claimed.add(key);
      return true;
    },
    async appendRun(run) {
      rows.push(run);
    },
    async finishRun(run) {
      const index = rows.findIndex((r) => r.runId === run.runId);
      if (index >= 0) {
        rows[index] = run;
      } else {
        rows.push(run);
      }
    },
    listRuns: async () => rows,
  };
  return {
    rows,
    claimed,
    runs,
    deps: {
      triggers,
      projects: { get: async () => project, list: async () => [], put: async () => {}, delete: async () => {} } as never,
      versions: {
        get: async () => (opts.published === undefined ? version : opts.published),
        list: async () => (opts.published === undefined ? [version] : []),
        put: async () => {},
        delete: async () => {},
      } as never,
      cipher: secretCipher,
      runSlots: memorySlots(),
      async *run(input) {
        runs.push({
          ...(input.variables ? { variables: input.variables } : {}),
          ...(input.message ? { message: input.message } : {}),
          actorKind: input.actor.kind,
        });
        if (opts.runThrows) {
          throw opts.runThrows;
        }
        for (const chunk of opts.chunks ?? [{ delta: { content: "done" } }]) {
          yield chunk;
        }
      },
    },
  };
}

describe("payloadInput", () => {
  it("flattens scalar payload fields into variables under the fixed ones", () => {
    const input = payloadInput(
      trigger({ payloadMode: "variables", variables: { env: "prod", who: "fixed" } }),
      { who: "payload", count: 3, ok: true, nested: { a: 1 } },
    );
    expect(input.variables).toEqual({ env: "prod", who: "payload", count: "3", ok: "true" });
    expect(input.message).toBeUndefined();
  });

  it("drops non-scalar fields rather than rendering them as [object Object]", () => {
    const input = payloadInput(trigger({ payloadMode: "variables" }), { nested: { a: 1 } });
    expect(input.variables).toEqual({});
  });

  it("serialises the payload into the message for an agent project", () => {
    const input = payloadInput(trigger({ payloadMode: "message" }), { event: "push" });
    expect(input.message).toContain('"event": "push"');
    expect(input.variables).toBeUndefined();
  });

  it("still says something when a delivery carries no payload", () => {
    expect(payloadInput(trigger(), undefined).message).toBe("Trigger fired with no payload.");
  });
});

describe("admitDelivery", () => {
  it("refuses a wrong secret", async () => {
    const f = fixture();
    const result = await admitDelivery(f.deps, "p", "nightly", "wrong", null);
    expect(result.status).toBe("unauthorized");
    expect(f.rows).toHaveLength(0);
  });

  it("refuses a missing secret", async () => {
    const f = fixture();
    expect((await admitDelivery(f.deps, "p", "nightly", null, null)).status).toBe(
      "unauthorized",
    );
  });

  it("reports an unknown trigger as not configured", async () => {
    const f = fixture({ stored: null });
    expect((await admitDelivery(f.deps, "p", "nope", SECRET, null)).status).toBe(
      "not-configured",
    );
  });

  it("checks the secret before the enabled flag", async () => {
    // A disabled trigger must not answer a wrong secret differently from an
    // enabled one; that difference is an oracle for which triggers exist.
    const f = fixture({ stored: trigger({ enabled: false }) });
    expect((await admitDelivery(f.deps, "p", "nightly", "wrong", null)).status).toBe(
      "unauthorized",
    );
  });

  it("does not run a disabled trigger", async () => {
    const f = fixture({ stored: trigger({ enabled: false }) });
    expect((await admitDelivery(f.deps, "p", "nightly", SECRET, null)).status).toBe(
      "disabled",
    );
    expect(f.rows).toHaveLength(0);
  });

  it("accepts a valid delivery and opens a running history row", async () => {
    const f = fixture();
    const result = await admitDelivery(f.deps, "p", "nightly", SECRET, null);
    expect(result.status).toBe("accepted");
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0]).toMatchObject({ status: "running", triggerId: "nightly" });
  });

  it("refuses a redelivery of the same Idempotency-Key without a second history row", async () => {
    const f = fixture();
    const first = await admitDelivery(f.deps, "p", "nightly", SECRET, "evt-1");
    expect(first.status).toBe("accepted");
    const second = await admitDelivery(f.deps, "p", "nightly", SECRET, "evt-1");
    expect(second.status).toBe("duplicate");
    expect(f.rows).toHaveLength(1);
  });

  it("treats different keys as different deliveries", async () => {
    // Overlap allowed, so the only thing that could refuse the second is the
    // idempotency claim — which is what this is about.
    const f = fixture({ stored: trigger({ allowConcurrent: true }) });
    await admitDelivery(f.deps, "p", "nightly", SECRET, "evt-1");
    expect((await admitDelivery(f.deps, "p", "nightly", SECRET, "evt-2")).status).toBe(
      "accepted",
    );
  });

  it("records a skip when the project has no published version", async () => {
    const f = fixture({ published: null });
    const result = await admitDelivery(f.deps, "p", "nightly", SECRET, null);
    expect(result.status).toBe("no-published-version");
    // A skip is a row: "it never fired" must be distinguishable in the console
    // from "it fired and failed" without reading logs.
    expect(f.rows).toEqual([expect.objectContaining({ status: "skipped" })]);
  });

  it("refuses an overlapping delivery when concurrency is not allowed", async () => {
    const f = fixture();
    const first = await admitDelivery(f.deps, "p", "nightly", SECRET, null);
    expect(first.status).toBe("accepted");
    const second = await admitDelivery(f.deps, "p", "nightly", SECRET, null);
    expect(second.status).toBe("busy");
    expect(f.rows.map((r) => r.status)).toEqual(["running", "skipped"]);
  });

  it("allows overlap when the trigger opts in", async () => {
    const f = fixture({ stored: trigger({ allowConcurrent: true }) });
    await admitDelivery(f.deps, "p", "nightly", SECRET, null);
    expect((await admitDelivery(f.deps, "p", "nightly", SECRET, null)).status).toBe(
      "accepted",
    );
  });

  it("frees the overlap lease once the delivery finishes", async () => {
    const f = fixture();
    const first = await admitDelivery(f.deps, "p", "nightly", SECRET, null);
    if (first.status !== "accepted") {
      throw new Error("expected an accepted delivery");
    }
    await executeDelivery(f.deps, first, {});
    expect((await admitDelivery(f.deps, "p", "nightly", SECRET, null)).status).toBe(
      "accepted",
    );
  });
});

describe("executeDelivery", () => {
  async function accept(f: Fixture) {
    const admitted = await admitDelivery(f.deps, "p", "nightly", SECRET, null);
    if (admitted.status !== "accepted") {
      throw new Error(`expected acceptance, got ${admitted.status}`);
    }
    return admitted;
  }

  it("records success with a bounded result and the trace id", async () => {
    const f = fixture({
      chunks: [{ delta: { content: "hello " } }, { delta: { content: "world" }, traceId: "t1" }],
    });
    await executeDelivery(f.deps, await accept(f), { a: 1 });
    expect(f.rows[0]).toMatchObject({ status: "succeeded", result: "hello world", traceId: "t1" });
    expect(f.rows[0]?.endedAt).toBeTruthy();
  });

  it("attributes the run to the trigger", async () => {
    const f = fixture();
    await executeDelivery(f.deps, await accept(f), {});
    expect(f.runs[0]?.actorKind).toBe("webhook");
    expect(triggerActor(trigger())).toEqual({ kind: "webhook", id: "p:nightly" });
  });

  it("ignores a subagent's text when accumulating the answer", async () => {
    const f = fixture({
      chunks: [
        { author: "child", delta: { content: "child output" } },
        { delta: { content: "parent answer" } },
      ],
    });
    await executeDelivery(f.deps, await accept(f), {});
    expect(f.rows[0]?.result).toBe("parent answer");
  });

  it("records an in-stream error as a failure", async () => {
    const f = fixture({ chunks: [{ error: "model exploded" }] });
    await executeDelivery(f.deps, await accept(f), {});
    expect(f.rows[0]).toMatchObject({ status: "failed", error: "model exploded" });
  });

  it("records the run's warnings on a succeeded row", async () => {
    // An unattended firing has nobody watching the stream: without the warning
    // on the row, a run its turn guard ended was a green `succeeded` while its
    // own trace said `turn-limit`.
    const f = fixture({
      chunks: [
        { delta: { content: "partial" } },
        { warning: "The run stopped at its turn limit (2 turns) before the model finished answering." },
        { finishReason: "turn-limit" },
      ],
    });
    await executeDelivery(f.deps, await accept(f), {});
    expect(f.rows[0]).toMatchObject({ status: "succeeded", result: "partial" });
    expect(f.rows[0]?.warning).toContain("turn limit");
  });

  it("does not record a subagent's warning as the run's", async () => {
    const f = fixture({
      chunks: [
        { author: "child", warning: "Subagent 'child' stopped at its turn limit (2 turns) before finishing; the main run continues." },
        { delta: { content: "answer" } },
        { done: true },
      ],
    });
    await executeDelivery(f.deps, await accept(f), {});
    expect(f.rows[0]?.warning).toBeUndefined();
  });

  it("records a thrown error as a failure rather than escaping", async () => {
    // Nothing is left to throw to: the response went out before this ran.
    const f = fixture({ runThrows: new Error("over the daily cost limit") });
    await expect(executeDelivery(f.deps, await accept(f), {})).resolves.toBeUndefined();
    expect(f.rows[0]).toMatchObject({ status: "failed", error: "over the daily cost limit" });
  });

  it("finishes the row and releases the slot when the payload itself cannot be shaped", async () => {
    // JSON.parse can hand back a body whose serialisation throws (deep
    // nesting); the toJSON throw stands in for that deterministically. The
    // regression this pins: a shaping failure once escaped the firing's
    // finally, leaving the row running and the overlap slot held for a lease.
    const f = fixture();
    const poison = {
      toJSON() {
        throw new Error("payload too deep");
      },
    };
    await expect(executeDelivery(f.deps, await accept(f), poison)).resolves.toBeUndefined();
    expect(f.rows[0]).toMatchObject({ status: "failed", error: "payload too deep" });
    expect(f.runs).toHaveLength(0);
    // The slot came back: the next delivery is admitted, not busy.
    expect((await admitDelivery(f.deps, "p", "nightly", SECRET, null)).status).toBe("accepted");
  });

  it("still finishes the row when history writes fail", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fixture();
    const admitted = await accept(f);
    f.deps.triggers.finishRun = async () => {
      throw new Error("dynamo down");
    };
    await expect(executeDelivery(f.deps, admitted, {})).resolves.toBeUndefined();
    error.mockRestore();
  });
});
