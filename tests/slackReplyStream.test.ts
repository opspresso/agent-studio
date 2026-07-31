import { afterEach, describe, expect, it, vi } from "vitest";
import { createReplySink, type ReplyTarget } from "@/application/slack/replyStream";
import type { SlackClientPort } from "@/application/slack/types";

const NOW = 1_750_000_000_000;

const DM: ReplyTarget = { channel: "D1", threadTs: "1.0", assistantThread: true };

/** Records only what these tests are about — the status text and its rotation. */
function makeSlackFake() {
  const statuses: Array<{ status: string; loading_messages?: string[] }> = [];
  const slack = {
    async setStatus(_token: string, args: { status: string; loading_messages?: string[] }) {
      statuses.push(
        "loading_messages" in args
          ? { status: args.status, loading_messages: args.loading_messages }
          : { status: args.status },
      );
    },
  } as unknown as SlackClientPort;
  return { slack, statuses };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the agent status line", () => {
  it("carries the rotating loading messages Slack animates", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { slack, statuses } = makeSlackFake();
    const sink = createReplySink(slack, "tok", DM);

    await sink.status("is thinking…", ["is thinking…", "is still on it…"]);

    expect(statuses).toEqual([
      { status: "is thinking…", loading_messages: ["is thinking…", "is still on it…"] },
    ]);
  });

  it("omits the argument entirely when there is nothing to rotate", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { slack, statuses } = makeSlackFake();
    const sink = createReplySink(slack, "tok", DM);

    await sink.status("is using search…");

    expect(statuses[0]).not.toHaveProperty("loading_messages");
  });

  it("does not repeat an unchanged status that Slack is still showing", async () => {
    let clock = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const { slack, statuses } = makeSlackFake();
    const sink = createReplySink(slack, "tok", DM);

    await sink.status("is thinking…");
    clock += 5_000;
    await sink.status("is thinking…");

    expect(statuses).toHaveLength(1);
  });

  it("sends it again once Slack is about to expire it", async () => {
    let clock = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const { slack, statuses } = makeSlackFake();
    const sink = createReplySink(slack, "tok", DM);

    await sink.status("is thinking…", ["is thinking…"]);
    // Slack drops a status two minutes after it is set, so a run longer than
    // that would otherwise go silent while it is still working.
    clock += 60_000;
    await sink.status("is thinking…", ["is thinking…"]);

    expect(statuses).toHaveLength(2);
    expect(statuses[1]).toEqual({ status: "is thinking…", loading_messages: ["is thinking…"] });
  });

  it("keeps a silent run's status alive on its own clock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { slack, statuses } = makeSlackFake();
    const sink = createReplySink(slack, "tok", DM);
    await sink.status("is thinking…", ["is thinking…"]);

    const stop = sink.keepStatusAlive();
    // No chunks arrive at all — a hung provider or a long tool. Refreshing only
    // on chunk arrival would go quiet exactly when the run is slowest.
    await vi.advanceTimersByTimeAsync(150_000);
    stop();

    expect(statuses.length).toBeGreaterThan(1);
    expect(statuses.every((entry) => entry.status === "is thinking…")).toBe(true);
    // Every refresh carries the rotation too, not a bare line.
    expect(statuses.at(-1)?.loading_messages).toEqual(["is thinking…"]);
  });

  it("stops refreshing once the run is over", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { slack, statuses } = makeSlackFake();
    const sink = createReplySink(slack, "tok", DM);
    await sink.status("is thinking…");

    const stop = sink.keepStatusAlive();
    stop();
    await vi.advanceTimersByTimeAsync(150_000);

    expect(statuses).toHaveLength(1);
  });

  it("never refreshes a cleared status", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { slack, statuses } = makeSlackFake();
    const sink = createReplySink(slack, "tok", DM);
    await sink.status("is thinking…");
    await sink.status("");

    const stop = sink.keepStatusAlive();
    await vi.advanceTimersByTimeAsync(150_000);
    stop();

    // A run that already answered must not re-announce that it is working.
    expect(statuses.map((entry) => entry.status)).toEqual(["is thinking…", ""]);
  });

  it("arms nothing for a channel thread, which has no status line", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { slack, statuses } = makeSlackFake();
    const sink = createReplySink(slack, "tok", {
      channel: "C1",
      threadTs: "1.0",
      assistantThread: false,
      recipient: { userId: "U1", teamId: "T1" },
    });
    await sink.status("is thinking…");

    const stop = sink.keepStatusAlive();
    await vi.advanceTimersByTimeAsync(150_000);
    stop();

    expect(statuses).toEqual([]);
  });
});
