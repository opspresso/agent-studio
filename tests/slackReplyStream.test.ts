import { afterEach, describe, expect, it, vi } from "vitest";
import { createReplySink, type ReplyTarget } from "@/application/slack/replyStream";
import type { SlackChunk, SlackClientPort } from "@/application/slack/types";

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

/**
 * A channel surface with **no streaming**: `startStream` is absent, so every
 * call falls through to post-and-edit. That is the fallback path, and naming it
 * matters — the tests under "progress in a channel thread" describe a workspace
 * that cannot stream, not the ordinary one.
 */
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

describe("progress in a channel thread that cannot stream", () => {
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

/** A channel surface that can stream, which is the ordinary one. */
function makeStreamingChannelFake() {
  const streamStarts: Array<Record<string, unknown>> = [];
  const chunks: Array<{ at: "start" | "append" | "stop"; chunk: SlackChunk }> = [];
  const appended: string[] = [];
  const stopped: Array<{ markdown_text?: string }> = [];
  const deleted: string[] = [];
  const posted: string[] = [];
  function record(at: "start" | "append" | "stop", list: SlackChunk[] | undefined): void {
    for (const chunk of list ?? []) {
      chunks.push({ at, chunk });
    }
  }
  const slack = {
    async startStream(_token: string, args: Record<string, unknown>) {
      streamStarts.push(args);
      record("start", args.chunks as SlackChunk[] | undefined);
      return { ts: "200.1", channel: "C1" };
    },
    async appendStream(
      _token: string,
      args: { markdown_text?: string; chunks?: SlackChunk[] },
    ) {
      if (args.markdown_text) {
        appended.push(args.markdown_text);
      }
      record("append", args.chunks);
    },
    async stopStream(_token: string, args: { markdown_text?: string; chunks?: SlackChunk[] }) {
      stopped.push({ ...(args.markdown_text ? { markdown_text: args.markdown_text } : {}) });
      record("stop", args.chunks);
    },
    async postMessage(_token: string, args: { text: string }) {
      posted.push(args.text);
      return { ts: "100.1", channel: "C1" };
    },
    async deleteMessage(_token: string, args: { ts: string }) {
      deleted.push(args.ts);
    },
  } as unknown as SlackClientPort;
  return { slack, streamStarts, chunks, appended, stopped, deleted, posted };
}

/**
 * The two axes of a streaming message. Progress is not text, so it does not
 * compete with the answer for the reply's body — which is what used to force a
 * channel run off streaming altogether.
 */
describe("progress on a channel stream's task axis", () => {
  it("opens the message with the first task rather than a posted note", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { slack, streamStarts, chunks, posted } = makeStreamingChannelFake();
    const sink = createReplySink(slack, "tok", CHANNEL);

    await sink.status("is thinking…");

    expect(posted).toEqual([]);
    expect(streamStarts[0]).toMatchObject({
      task_display_mode: "timeline",
      recipient_user_id: "U1",
      recipient_team_id: "T1",
    });
    expect(chunks).toEqual([
      {
        at: "start",
        chunk: { type: "task_update", id: "run-progress", title: "is thinking…", status: "in_progress" },
      },
    ]);
  });

  it("retitles the one task instead of adding a row per step", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { slack, chunks } = makeStreamingChannelFake();
    const sink = createReplySink(slack, "tok", CHANNEL);

    await sink.status("is thinking…");
    await sink.status("is using search…");
    // Unchanged: a task does not expire, so re-sending it shows nothing.
    await sink.status("is using search…");

    expect(chunks.map((entry) => entry.chunk)).toEqual([
      { type: "task_update", id: "run-progress", title: "is thinking…", status: "in_progress" },
      { type: "task_update", id: "run-progress", title: "is using search…", status: "in_progress" },
    ]);
  });

  it("streams the answer into the same message and completes the task at the end", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { slack, appended, stopped, chunks, streamStarts } = makeStreamingChannelFake();
    const sink = createReplySink(slack, "tok", CHANNEL);

    await sink.status("is using search…");
    await sink.push("found ");
    await sink.finish("found it", "");

    // One message for both axes — the progress never had to be overwritten.
    expect(streamStarts).toHaveLength(1);
    expect(appended.join("")).toBe("found ");
    expect(stopped).toEqual([{ markdown_text: "it" }]);
    // A step left `in_progress` on a finished message reads as a run that never
    // came back.
    expect(chunks.at(-1)).toEqual({
      at: "stop",
      chunk: { type: "task_update", id: "run-progress", title: "is using search…", status: "complete" },
    });
  });

  it("takes back a message that only ever held a task", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { slack, deleted, stopped } = makeStreamingChannelFake();
    const sink = createReplySink(slack, "tok", CHANNEL);

    await sink.status("is thinking…");
    // A picture-only run: the answer went out as an upload this sink never saw.
    await sink.finish("", "");

    // Closed before it is deleted — removing a message Slack still considers
    // open leaves it mid-write.
    expect(stopped).toHaveLength(1);
    expect(deleted).toEqual(["200.1"]);
  });

  it("sets no task layout on an agent thread, which has the status line", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { slack, streamStarts, chunks } = makeStreamingChannelFake();
    const sink = createReplySink(slack, "tok", DM);

    await sink.push("hello");

    expect(chunks).toEqual([]);
    expect(streamStarts[0]).not.toHaveProperty("task_display_mode");
  });
});

/**
 * The checklist. Claude Tag's defining progress surface is a list that
 * accumulates — steps ticked off behind, one in flight — rather than a single
 * line that keeps being rewritten. The constraint that shapes it: a step may
 * only be ticked off at a *real* boundary, and the only one a run has is a tool
 * result coming back.
 */
describe("a channel's checklist", () => {
  const rows = (chunks: Array<{ chunk: SlackChunk }>) =>
    chunks
      .map(({ chunk }) => chunk)
      .filter((chunk) => chunk.type === "task_update")
      .map((chunk) => `${chunk.id}/${chunk.title}/${chunk.status}`);

  it("accumulates a row per step and ticks each off on its own", async () => {
    const { slack, chunks } = makeStreamingChannelFake();
    const sink = createReplySink(slack, "tok", CHANNEL);

    await sink.status("is thinking…");
    await sink.step("c1", "search");
    await sink.step("c2", "fetch");
    await sink.stepDone("c1", "web: search");
    await sink.stepDone("c2");
    await sink.finish("done", "");

    expect(rows(chunks)).toEqual([
      "run-progress/is thinking…/in_progress",
      // Closed the moment there is something specific to list: a row spinning
      // above a list that is visibly moving reads as a stuck run.
      "run-progress/is thinking…/complete",
      "c1/search/in_progress",
      "c2/fetch/in_progress",
      // Retitled by the result, which names what the call acted on.
      "c1/web: search/complete",
      "c2/fetch/complete",
    ]);
  });

  it("closes a step the run never finished, on the way out", async () => {
    // A timeout or a failed run leaves work in flight. A row left in_progress
    // on a finished message reads as a run that never came back.
    const { slack, chunks } = makeStreamingChannelFake();
    const sink = createReplySink(slack, "tok", CHANNEL);

    await sink.step("c1", "search");
    await sink.finish("gave up", ":warning: Agent run timed out");

    expect(rows(chunks)).toEqual(["c1/search/in_progress", "c1/search/complete"]);
  });

  it("ticks nothing off for a step that never opened", async () => {
    // The only completion boundary is a result for a call that was announced.
    // An unopened id would appear as a finished row for work nobody watched
    // start — which is how a checklist starts describing a different run.
    const { slack, chunks } = makeStreamingChannelFake();
    const sink = createReplySink(slack, "tok", CHANNEL);

    await sink.stepDone("c_never", "search");
    await sink.finish("done", "");

    expect(rows(chunks)).toEqual([]);
  });

  it("does not re-send a step it is already showing", async () => {
    const { slack, chunks } = makeStreamingChannelFake();
    const sink = createReplySink(slack, "tok", CHANNEL);

    await sink.step("c1", "search");
    await sink.step("c1", "search");
    await sink.finish("done", "");

    expect(rows(chunks)).toEqual(["c1/search/in_progress", "c1/search/complete"]);
  });

  it("keeps the ambient row when no step ever replaced it", async () => {
    // A run that answers without calling anything still has to close the row it
    // opened with.
    const { slack, chunks } = makeStreamingChannelFake();
    const sink = createReplySink(slack, "tok", CHANNEL);

    await sink.status("is thinking…");
    await sink.finish("here you go", "");

    expect(rows(chunks)).toEqual([
      "run-progress/is thinking…/in_progress",
      "run-progress/is thinking…/complete",
    ]);
  });
});
