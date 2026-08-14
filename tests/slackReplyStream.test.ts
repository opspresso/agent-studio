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
    const { slack, statuses } = makeChannelFake();
    const sink = createReplySink(slack, "tok", CHANNEL);
    await sink.status("is thinking…");

    const stop = sink.keepStatusAlive();
    await vi.advanceTimersByTimeAsync(150_000);
    stop();

    // A posted message does not expire the way a status line does, so there is
    // nothing for the heartbeat to keep alive.
    expect(statuses).toEqual([]);
  });
});

const CHANNEL: ReplyTarget = {
  channel: "C1",
  threadTs: "1.0",
  assistantThread: false,
  recipient: { userId: "U1", teamId: "T1" },
};

const INDICATOR = ":hourglass_flowing_sand:";

/** Records the one message a channel thread's progress and answer share. */
function makeChannelFake() {
  const posted: string[] = [];
  const updates: Array<{ channel: string; ts: string; text: string }> = [];
  const deleted: string[] = [];
  const statuses: string[] = [];
  const slack = {
    async postMessage(_token: string, args: { channel: string; text: string }) {
      posted.push(args.text);
      return { ts: "100.1", channel: args.channel };
    },
    async updateMessage(_token: string, args: { channel: string; ts: string; text: string }) {
      updates.push(args);
      return { ts: args.ts };
    },
    async deleteMessage(_token: string, args: { ts: string }) {
      deleted.push(args.ts);
    },
    async setStatus(_token: string, args: { status: string }) {
      statuses.push(args.status);
    },
  } as unknown as SlackClientPort;
  return { slack, posted, updates, deleted, statuses };
}

describe("progress in a channel thread", () => {
  it("posts the first progress and edits that message after it", async () => {
    let clock = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const { slack, posted, updates, statuses } = makeChannelFake();
    const sink = createReplySink(slack, "tok", CHANNEL);

    await sink.status("is thinking…");
    clock += 5000;
    await sink.status("is using search…");

    expect(posted).toEqual([`_is thinking…_ ${INDICATOR}`]);
    expect(updates).toEqual([
      { channel: "C1", ts: "100.1", text: `_is using search…_ ${INDICATOR}` },
    ]);
    // The surface has no status line; nothing is spent trying to set one.
    expect(statuses).toEqual([]);
  });

  it("does not rewrite the note with what it already says", async () => {
    let clock = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const { slack, updates } = makeChannelFake();
    const sink = createReplySink(slack, "tok", CHANNEL);

    await sink.status("is using search…");
    clock += 5000;
    // The same tool again — a run may call one a dozen times in a row.
    await sink.status("is using search…");

    expect(updates).toEqual([]);
  });

  it("paces the note against Slack's edit limit", async () => {
    let clock = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const { slack, updates } = makeChannelFake();
    const sink = createReplySink(slack, "tok", CHANNEL);

    await sink.status("is thinking…");
    clock += 1000;
    await sink.status("is using search…");

    expect(updates).toEqual([]);
  });

  it("lands the answer on the message the note opened", async () => {
    let clock = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const { slack, posted, updates } = makeChannelFake();
    const sink = createReplySink(slack, "tok", CHANNEL);

    await sink.status("is thinking…");
    clock += 5000;
    await sink.push("found");
    clock += 5000;
    await sink.finish("found it", "");

    expect(posted).toHaveLength(1);
    expect(updates.at(-1)).toEqual({ channel: "C1", ts: "100.1", text: "found it" });
  });

  it("stops writing progress once the answer has started arriving", async () => {
    let clock = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const { slack, updates } = makeChannelFake();
    const sink = createReplySink(slack, "tok", CHANNEL);

    await sink.status("is thinking…");
    clock += 5000;
    await sink.push("partial");
    clock += 5000;
    await sink.status("is using search…");

    // The message belongs to the answer now — a later tool name must not write
    // over text the reader is already reading.
    expect(updates.map((update) => update.text)).toEqual([`partial ${INDICATOR}`]);
  });

  it("takes the note back when the run had no text to put in its place", async () => {
    let clock = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const { slack, updates, deleted } = makeChannelFake();
    const sink = createReplySink(slack, "tok", CHANNEL);

    await sink.status("is thinking…");
    clock += 5000;
    // What a picture-only run leaves the sink: the answer went out as an upload
    // this sink never saw.
    await sink.finish("", "");

    expect(deleted).toEqual(["100.1"]);
    expect(updates).toEqual([]);
  });

  it("adds no message to a DM, which shows progress on its status line", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { slack, posted, statuses } = makeChannelFake();
    const sink = createReplySink(slack, "tok", DM);

    await sink.status("is thinking…");

    expect(posted).toEqual([]);
    expect(statuses).toEqual(["is thinking…"]);
  });
});
