import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { deleteItem, getItem, putItem } from "@/infrastructure/db/store";
import { keys } from "@/infrastructure/db/keys";
import { slackRunControlRepository as repository } from "@/infrastructure/db/repositories/slackRunControlRepository";
import { slackTimestampValue } from "@/domain/slack/runControl";
import { watchSlackStop } from "@/application/slack/watchStop";
import { SLACK_RUN_LEASE_SECONDS, SLACK_STOP_TTL_SECONDS } from "@/infrastructure/db/ttl";

vi.mock("node:crypto", async (original) => ({ ...await original<typeof import("node:crypto")>(), randomUUID: vi.fn() }));

const NOW = 1_750_000_000_000;
const target = { agentName: "stop-test", channel: "C1", threadTs: "1.0" };
beforeEach(async () => {
  let token = 0;
  vi.mocked(randomUUID).mockImplementation(() => `00000000-0000-4000-8000-${String(++token).padStart(12, "0")}`);
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  await putItem({ ...keys.agent(target.agentName), entityType: "AGENT" });
  await deleteItem(keys.slackRunControl(target.agentName, target.channel, target.threadTs));
  await deleteItem(keys.slackRunLease(target.agentName, target.channel, target.threadTs));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Slack stop delivery", () => {
  it("allows one thread owner, renews its lease and fences stale release after takeover", async () => {
    const first = await repository.acquire(target);
    expect(first).not.toBeNull();
    expect(await repository.acquire(target)).toBeNull();
    vi.advanceTimersByTime(SLACK_RUN_LEASE_SECONDS * 600);
    expect(await repository.renew(target, first!)).toBe(true);
    vi.advanceTimersByTime(SLACK_RUN_LEASE_SECONDS * 600);
    expect(await repository.acquire(target)).toBeNull();
    vi.advanceTimersByTime(SLACK_RUN_LEASE_SECONDS * 1000);
    const second = await repository.acquire(target);
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(await repository.renew(target, first!)).toBe(false);
    await repository.release(target, first!);
    expect(await repository.acquire(target)).toBeNull();
    await repository.release(target, second!);
    expect(await repository.acquire(target)).not.toBeNull();
  });

  it("awaits an in-flight refresh before deciding whether final delivery may proceed", async () => {
    const check = vi.fn().mockResolvedValueOnce(false);
    const run = await watchSlackStop({ ...repository, stoppedAfter: check }, target, "3.0");
    let respond!: (stopped: boolean) => void;
    check.mockImplementation(() => new Promise<boolean>((resolve) => { respond = resolve; }));
    vi.advanceTimersByTime(1000);
    let done = false;
    const refresh = run.check().then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    respond(true);
    await refresh;
    expect(run.signal.aborted).toBe(true);
    run.dispose();
  });

  it("prevents a stale lease holder from writing status or output", async () => {
    const token = await repository.acquire(target);
    const run = await watchSlackStop(repository, target, "3.0", token!);
    await repository.release(target, token!);
    await repository.acquire(target);
    await run.check();
    expect(run.signal.aborted).toBe(true);
    expect(run.canWrite()).toBe(false);
    run.dispose();
  });
  it("uses exact microsecond ordering and rejects malformed timestamps", () => {
    expect(slackTimestampValue("1750000000.000001")! - slackTimestampValue("1750000000.000000")!).toBe(1n);
    expect(slackTimestampValue("1.9")).toBeGreaterThan(slackTimestampValue("1.10")!);
    for (const input of [undefined, {}, "NaN", "1e3", "-1", "1.1234567"]) {
      expect(slackTimestampValue(input)).toBeNull();
    }
  });

  it("keeps the latest stop across out-of-order delivery and isolates agents and threads", async () => {
    await repository.requestStop(target, "2.8");
    await repository.requestStop(target, "2.3");
    expect(await repository.stoppedAfter(target, "2.7")).toBe(true);
    expect(await repository.stoppedAfter(target, "2.8")).toBe(true);
    expect(await repository.stoppedAfter(target, "2.9")).toBe(false);
    expect(await repository.stoppedAfter({ ...target, threadTs: "9.0" }, "2.7")).toBe(false);
    expect(await repository.stoppedAfter({ ...target, agentName: "other" }, "2.7")).toBe(false);
  });

  it("expires stop records and refuses writes under a deleted agent", async () => {
    await repository.requestStop(target, "2.8");
    const row = await getItem(keys.slackRunControl(target.agentName, target.channel, target.threadTs));
    expect(row?.expiresAt).toBe(NOW / 1000 + SLACK_STOP_TTL_SECONDS);
    vi.setSystemTime(NOW + (SLACK_STOP_TTL_SECONDS + 1) * 1000);
    expect(await repository.stoppedAfter(target, "2.7")).toBe(false);
    await expect(repository.requestStop({ ...target, agentName: "deleted" }, "2.8")).rejects.toThrow();
  });

  it("cancels through a shared store even when another handler records the stop", async () => {
    const running = await watchSlackStop(repository, target, "3.0");
    expect(running.signal.aborted).toBe(false);
    await repository.requestStop(target, "3.1");
    await vi.advanceTimersByTimeAsync(1000);
    expect(running.signal.aborted).toBe(true);
    expect(running.signal.reason.name).toBe("AbortError");
    running.dispose();
    expect(vi.getTimerCount()).toBe(0);
    const next = await watchSlackStop(repository, target, "3.2");
    expect(next.signal.aborted).toBe(false);
    next.dispose();
  });

  it("cancels delayed work before its first model call and fails closed on lookup failure", async () => {
    await repository.requestStop(target, "4.1");
    const delayed = await watchSlackStop(repository, target, "4.0");
    expect(delayed.signal.aborted).toBe(true);
    delayed.dispose();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const stoppedAfter = vi.fn().mockRejectedValue(new Error("DB unavailable"));
    const failed = await watchSlackStop({ ...repository, stoppedAfter }, target, "5.0");
    expect(failed.signal.reason.message).toContain("cancellation state");
    failed.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
