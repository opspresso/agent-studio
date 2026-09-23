import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteItem, getItem, putItem } from "@/infrastructure/db/store";
import { keys } from "@/infrastructure/db/keys";
import { slackRunControlRepository as repository } from "@/infrastructure/db/repositories/slackRunControlRepository";
import { slackTimestampValue } from "@/domain/slack/runControl";
import { watchSlackStop } from "@/application/slack/watchStop";
import { SLACK_STOP_TTL_SECONDS } from "@/infrastructure/db/ttl";

const NOW = 1_750_000_000_000;
const target = { projectName: "stop-test", channel: "C1", threadTs: "1.0" };
beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  await putItem({ ...keys.project(target.projectName), entityType: "PROJECT" });
  await deleteItem(keys.slackRunControl(target.projectName, target.channel, target.threadTs));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Slack stop delivery", () => {
  it("uses exact microsecond ordering and rejects malformed timestamps", () => {
    expect(slackTimestampValue("1750000000.000001")! - slackTimestampValue("1750000000.000000")!).toBe(1n);
    expect(slackTimestampValue("1.9")).toBeGreaterThan(slackTimestampValue("1.10")!);
    for (const input of [undefined, {}, "NaN", "1e3", "-1", "1.1234567"]) {
      expect(slackTimestampValue(input)).toBeNull();
    }
  });

  it("keeps the latest stop across out-of-order delivery and isolates projects and threads", async () => {
    await repository.requestStop(target, "2.8");
    await repository.requestStop(target, "2.3");
    expect(await repository.stoppedAfter(target, "2.7")).toBe(true);
    expect(await repository.stoppedAfter(target, "2.8")).toBe(true);
    expect(await repository.stoppedAfter(target, "2.9")).toBe(false);
    expect(await repository.stoppedAfter({ ...target, threadTs: "9.0" }, "2.7")).toBe(false);
    expect(await repository.stoppedAfter({ ...target, projectName: "other" }, "2.7")).toBe(false);
  });

  it("expires stop records and refuses writes under a deleted project", async () => {
    await repository.requestStop(target, "2.8");
    const row = await getItem(keys.slackRunControl(target.projectName, target.channel, target.threadTs));
    expect(row?.expiresAt).toBe(NOW / 1000 + SLACK_STOP_TTL_SECONDS);
    vi.setSystemTime(NOW + (SLACK_STOP_TTL_SECONDS + 1) * 1000);
    expect(await repository.stoppedAfter(target, "2.7")).toBe(false);
    await expect(repository.requestStop({ ...target, projectName: "deleted" }, "2.8")).rejects.toThrow();
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
