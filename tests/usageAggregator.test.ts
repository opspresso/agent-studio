import { describe, expect, it, vi } from "vitest";
import { createUsageAggregator } from "@/application/usage/recordUsage";
import type { UsageRepository } from "@/domain/usage/repository";
import type { UsageDelta } from "@/domain/usage/types";

function fakeUsageRepo(onRecord?: (delta: UsageDelta) => void) {
  const writes: UsageDelta[] = [];
  const repo: UsageRepository = {
    async record(delta) {
      onRecord?.(delta);
      writes.push(delta);
    },
    async getDay() {
      return null;
    },
    async getMemberMonth() {
      return null;
    },
    async claimAlert() {
      return false;
    },
    async claimMonthAlert() {
      return false;
    },
    async listActorsByProject() {
      return [];
    },
    async listByProject() {
      return [];
    },
    async listByDateRange() {
      return [];
    },
  };
  return { repo, writes };
}

describe("createUsageAggregator", () => {
  it("buffers records and writes nothing until flush", async () => {
    const { repo, writes } = fakeUsageRepo();
    const agg = createUsageAggregator(repo);
    await agg.record({ projectName: "p", model: "m", inputTokens: 10, outputTokens: 5, costUsd: 0.01 });
    expect(writes).toHaveLength(0);
  });

  it("collapses repeated same-model records into one summed write", async () => {
    const { repo, writes } = fakeUsageRepo();
    const agg = createUsageAggregator(repo);
    const date = "2026-01-01";
    await agg.record({ projectName: "p", model: "m", inputTokens: 10, outputTokens: 5, costUsd: 0.01, date });
    await agg.record({ projectName: "p", model: "m", inputTokens: 20, outputTokens: 7, costUsd: 0.02, date });
    await agg.record({ projectName: "p", model: "m", inputTokens: 1, outputTokens: 1, costUsd: 0.03, date });
    await agg.flush();

    expect(writes).toHaveLength(1);
    const write = writes[0]!;
    expect(write).toMatchObject({ projectName: "p", model: "m", date, calls: 3, inputTokens: 31, outputTokens: 13 });
    expect(write.costUsd).toBeCloseTo(0.06);
  });

  it("keeps a separate write per (date, model)", async () => {
    const { repo, writes } = fakeUsageRepo();
    const agg = createUsageAggregator(repo);
    await agg.record({ projectName: "p", model: "a", inputTokens: 1, outputTokens: 1, costUsd: 0.01, date: "2026-01-01" });
    await agg.record({ projectName: "p", model: "b", inputTokens: 2, outputTokens: 2, costUsd: 0.02, date: "2026-01-01" });
    await agg.record({ projectName: "p", model: "a", inputTokens: 3, outputTokens: 3, costUsd: 0.03, date: "2026-01-02" });
    await agg.flush();

    expect(writes).toHaveLength(3);
    const modelA0101 = writes.find((w) => w.model === "a" && w.date === "2026-01-01")!;
    expect(modelA0101.calls).toBe(1);
    expect(modelA0101.inputTokens).toBe(1);
  });

  it("flush is best-effort: a write failure is logged, not thrown", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { repo } = fakeUsageRepo(() => {
      throw new Error("dynamo down");
    });
    const agg = createUsageAggregator(repo);
    await agg.record({ projectName: "p", model: "m", inputTokens: 1, outputTokens: 1, costUsd: 0.01 });
    // Still reports the project it tried to write: the caller settles that
    // project's thresholds off this list, and a failed write is exactly when
    // its spend is least well known — dropping it here would make a lost write
    // silently skip the notification too.
    await expect(agg.flush()).resolves.toEqual(["p"]);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  /**
   * A transfer spends on a project the run bracket never admitted, and
   * `settleCostLimit` — the only thing that claims the block and alert
   * notifications — is called for the project the bracket opened. Without this
   * list a project reached only through transfers accrued spend, began refusing
   * at its threshold, and told nobody.
   */
  it("reports every distinct project it wrote for, once each", async () => {
    const { repo } = fakeUsageRepo();
    const agg = createUsageAggregator(repo);
    const call = { model: "m", inputTokens: 1, outputTokens: 1, costUsd: 0.01 };

    await agg.record({ projectName: "parent", ...call });
    await agg.record({ projectName: "child", ...call });
    await agg.record({ projectName: "parent", ...call, model: "other" });

    expect((await agg.flush()).sort()).toEqual(["child", "parent"]);
  });

  it("reports nothing when it wrote nothing", async () => {
    const { repo } = fakeUsageRepo();

    expect(await createUsageAggregator(repo).flush()).toEqual([]);
  });

  it("flush clears buffered totals so a second flush writes nothing", async () => {
    const { repo, writes } = fakeUsageRepo();
    const agg = createUsageAggregator(repo);
    await agg.record({ projectName: "p", model: "m", inputTokens: 1, outputTokens: 1, costUsd: 0.01 });
    await agg.flush();
    await agg.flush();
    expect(writes).toHaveLength(1);
  });
});
