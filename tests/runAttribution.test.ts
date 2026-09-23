import { describe, expect, it } from "vitest";
import { actorKey, descend, type RunActor } from "@/domain/execution/actor";
import { principalActor } from "@/app/api/projects/_lib/executionAuth";
import { createUsageAggregator, recordUsage } from "@/application/usage/recordUsage";
import { TraceRecorder } from "@/application/trace/recorder";
import type { Trace } from "@/domain/trace/types";
import type { UsageDelta } from "@/domain/usage/types";
import type { UsageRepository } from "@/domain/usage/repository";

function fakeUsage() {
  const writes: UsageDelta[] = [];
  const repo: UsageRepository = {
    async record(delta) {
      writes.push(delta);
    },
    getDay: async () => null,
    listMemberDays: async () => [],
    claimAlert: async () => false,
    claimMonthAlert: async () => false,
    listActorsByProject: async () => [],
    listByProject: async () => [],
    listByDateRange: async () => [],
  };
  return { repo, writes };
}

describe("actorKey", () => {
  it("qualifies the id by kind", () => {
    expect(actorKey({ kind: "user", id: "a@example.com" })).toBe("user:a@example.com");
    expect(actorKey({ kind: "slack", id: "U123" })).toBe("slack:U123");
  });

  it("keeps a token's spend apart from its owner's own runs", () => {
    // Both authenticate as the same person; only the kind says which is which,
    // and telling them apart is the whole reason to attribute at all.
    const owner: RunActor = { kind: "user", id: "a@example.com" };
    const token: RunActor = { kind: "project-token", id: "a@example.com" };
    expect(actorKey(owner)).not.toBe(actorKey(token));
  });
});

describe("principalActor", () => {
  it("maps a session principal to a user actor", () => {
    expect(principalActor({ email: "a@example.com", viaToken: false })).toEqual({
      kind: "user",
      id: "a@example.com",
    });
  });

  it("maps a token principal to its own kind, carrying the owner's email", () => {
    expect(principalActor({ email: "a@example.com", viaToken: true })).toEqual({
      kind: "project-token",
      id: "a@example.com",
    });
  });
});

describe("descend", () => {
  it("extends the chain and keeps the actor", () => {
    const origin = { actor: { kind: "user", id: "a@example.com" } as RunActor, ancestry: ["top"] };
    expect(descend(origin, "child")).toEqual({
      actor: { kind: "user", id: "a@example.com" },
      ancestry: ["top", "child"],
    });
  });

  it("does not mutate the parent's chain", () => {
    const origin = { ancestry: ["top"] };
    descend(origin, "child");
    expect(origin.ancestry).toEqual(["top"]);
  });
});

describe("usage attribution", () => {
  it("records the actor alongside the project total", async () => {
    const { repo, writes } = fakeUsage();
    await recordUsage(repo, {
      projectName: "p",
      model: "m",
      inputTokens: 1,
      outputTokens: 2,
      costUsd: 0.5,
      actor: "user:a@example.com",
    });
    expect(writes[0]).toMatchObject({ projectName: "p", actor: "user:a@example.com" });
  });

  it("omits the actor entirely when the run has none", async () => {
    const { repo, writes } = fakeUsage();
    await recordUsage(repo, {
      projectName: "p",
      model: "m",
      inputTokens: 1,
      outputTokens: 2,
      costUsd: 0.5,
    });
    expect(writes[0]).not.toHaveProperty("actor");
  });

  it("stamps the run's actor on every flushed total, across projects", async () => {
    const { repo, writes } = fakeUsage();
    const aggregator = createUsageAggregator(repo, "user:a@example.com");
    // A subagent transfer spends on another project, but it is still this
    // person's run — the actor is the run's, not the turn's.
    await aggregator.record({
      projectName: "parent",
      model: "m",
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 1,
    });
    await aggregator.record({
      projectName: "child",
      model: "m",
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 2,
    });
    await aggregator.flush();
    expect(writes.map((w) => [w.projectName, w.actor])).toEqual([
      ["parent", "user:a@example.com"],
      ["child", "user:a@example.com"],
    ]);
  });
});

describe("trace attribution", () => {
  async function recordedTrace(actor?: RunActor): Promise<Trace> {
    const traces: Trace[] = [];
    const recorder = new TraceRecorder(
      { put: async (t: Trace) => void traces.push(t) } as never,
      {
        projectName: "p",
        projectType: "agent",
        model: "m",
        messageCount: 1,
        ...(actor ? { actor } : {}),
      },
    );
    await recorder.finish();
    return traces[0]!;
  }

  it("records who caused the run", async () => {
    const trace = await recordedTrace({ kind: "slack", id: "U123" });
    expect(trace.actor).toEqual({ kind: "slack", id: "U123" });
  });

  it("leaves the field off when there is no actor", async () => {
    expect(await recordedTrace()).not.toHaveProperty("actor");
  });


});
