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
function makeChannelFake(opts: { refuseOver?: number; refusePost?: number } = {}) {
  const posted: string[] = [];
  const updates: Array<{ channel: string; ts: string; text: string }> = [];
  const deleted: string[] = [];
  const statuses: string[] = [];
  // A reply that outgrows one message opens the next one, so each post is its
  // own ts — the first is still `100.1`.
  let messages = 0;
  const slack = {
    async postMessage(_token: string, args: { channel: string; text: string }) {
      if (opts.refuseOver !== undefined && args.text.length > opts.refuseOver) {
        throw new Error("Slack chat.postMessage failed: msg_too_long");
      }
      if (opts.refusePost === messages + 1) {
        opts.refusePost = undefined;
        throw new Error("Slack chat.postMessage failed: ratelimited");
      }
      posted.push(args.text);
      messages += 1;
      return { ts: `100.${messages}`, channel: args.channel };
    },
    async updateMessage(_token: string, args: { channel: string; ts: string; text: string }) {
      if (opts.refuseOver !== undefined && args.text.length > opts.refuseOver) {
        throw new Error("Slack chat.update failed: msg_too_long");
      }
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
/**
 * The two rules Slack enforces on one stream, which the fakes enforce because
 * not enforcing them is exactly how both shipped:
 *
 * - `markdown_text` and `chunks` on the same request is
 *   `cannot_provide_both_markdown_text_and_chunks`;
 * - the mode a stream opens in is the mode it stays in — the other one later is
 *   `streaming_mode_mismatch`. A channel's progress rows are chunks and they
 *   open the message, so on a channel the answer must travel as a
 *   `markdown_text` *chunk*.
 *
 * Passing tests accepted calls Slack rejects, twice, and `push` swallows a
 * failed append — so every channel run silently dropped its whole answer.
 */
function streamModeGuard() {
  let mode: "text" | "chunks" | undefined;
  return (
    method: string,
    args: { markdown_text?: string; text?: string; chunks?: unknown[] },
  ): void => {
    const hasText = (args.markdown_text ?? args.text) !== undefined;
    const hasChunks = args.chunks !== undefined;
    if (hasText && hasChunks) {
      throw new Error(`Slack ${method} failed: cannot_provide_both_markdown_text_and_chunks`);
    }
    const used = hasChunks ? "chunks" : hasText ? "text" : undefined;
    if (!used) {
      return;
    }
    if (mode === undefined) {
      mode = used;
      return;
    }
    if (mode !== used) {
      throw new Error(`Slack ${method} failed: streaming_mode_mismatch`);
    }
  };
}

function makeStreamingChannelFake() {
  const guard = streamModeGuard();
  const streamStarts: Array<Record<string, unknown>> = [];
  const chunks: Array<{ at: "start" | "append" | "stop"; chunk: SlackChunk }> = [];
  const appended: string[] = [];
  const stopped: Array<{ markdown_text?: string }> = [];
  const deleted: string[] = [];
  const posted: string[] = [];
  const statuses: string[] = [];
  function record(at: "start" | "append" | "stop", list: SlackChunk[] | undefined): void {
    for (const chunk of list ?? []) {
      // Text is text whichever envelope carried it — a test about the answer
      // should not have to know which mode the stream is in.
      if (chunk.type === "markdown_text") {
        appended.push(chunk.text);
        continue;
      }
      chunks.push({ at, chunk });
    }
  }
  const slack = {
    async startStream(_token: string, args: Record<string, unknown>) {
      guard("chat.startStream", args as never);
      streamStarts.push(args);
      record("start", args.chunks as SlackChunk[] | undefined);
      return { ts: "200.1", channel: "C1" };
    },
    async appendStream(
      _token: string,
      args: { markdown_text?: string; chunks?: SlackChunk[] },
    ) {
      guard("chat.appendStream", args);
      if (args.markdown_text) {
        appended.push(args.markdown_text);
      }
      record("append", args.chunks);
    },
    async stopStream(_token: string, args: { markdown_text?: string; chunks?: SlackChunk[] }) {
      guard("chat.stopStream", args);
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
    // An assistant thread carries its progress as a status rather than as task
    // rows, so a DM target reaches for this on the way in and on the way out.
    async setStatus(_token: string, args: { status: string }) {
      statuses.push(args.status);
    },
  } as unknown as SlackClientPort;
  return { slack, streamStarts, chunks, appended, stopped, deleted, posted, statuses };
}

/**
 * The two axes of a streaming message. Progress is not text, so it does not
 * compete with the answer for the reply's body — which is what would force a
 * channel run off streaming altogether.
 */
describe("progress on a channel stream's task axis", () => {
  it("keeps a failed tool visible even when another call in the same row succeeds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { slack, chunks } = makeStreamingChannelFake();
    const sink = createReplySink(slack, "tok", CHANNEL);
    await sink.step("call-1", "Search");
    await sink.step("call-2", "Search");
    await sink.stepDone("call-1", "Search", { failed: true });
    await sink.stepDone("call-2", "Search");
    await sink.finish("Only one source was available.", "");
    expect(chunks.at(-1)?.chunk).toEqual({ type: "task_update", id: "Search", title: "Search ×2", status: "error" });
  });
  it("marks unfinished work as failed instead of reporting successful completion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { slack, chunks } = makeStreamingChannelFake();
    const sink = createReplySink(slack, "tok", CHANNEL);
    await sink.step("call-1", "Deploy");
    await sink.finish("", ":warning: deployment failed", "failed");
    expect(chunks.filter(({ at }) => at === "stop").map(({ chunk }) => chunk)).toContainEqual({
      type: "task_update", id: "Deploy", title: "Deploy", status: "error",
    });
  });

  it("does not replay buffered output when Slack already stopped the stream", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { slack, posted, appended, statuses } = makeStreamingChannelFake();
    const sink = createReplySink(slack, "tok", DM);
    await sink.status("is thinking…");
    await sink.push("visible");
    await sink.push("visible buffered");
    slack.stopStream = async () => { throw new Error("message_not_in_streaming_state"); };
    await sink.finish("visible buffered", "Stopped by user.", "cancelled");
    expect(appended).toEqual(["visible"]);
    expect(posted).toEqual(["Stopped by user."]);
    expect(statuses.at(-1)).toBe("");
  });
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
    // Both halves arrive as chunks, because the progress row opened the stream
    // in chunks mode and Slack keeps a stream in the mode it opened in. The
    // answer is a `markdown_text` chunk, which is a listed chunk type.
    expect(appended.join("")).toBe("found it");
    expect(stopped).toEqual([{}]);
    // A step left `in_progress` on a finished message reads as a run that never
    // came back, so the unfinished rows ride out on the close — alongside the
    // last of the answer, since in this mode both are chunks.
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

  it("accumulates a row per tool and ticks each off on its own", async () => {
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
      "search/search/in_progress",
      "fetch/fetch/in_progress",
      // Retitled by the result, which names what the call acted on — and only
      // because this row stands for a single call.
      "search/web: search/complete",
      "fetch/fetch/complete",
    ]);
  });

  it("collapses repeated reaches for the same tool into one counted row", async () => {
    // Five reads of the same channel would be five identical rows. A
    // checklist is meant to say what the run is doing, and "SlackHistory ×5" is
    // that sentence — five copies of it are not.
    const { slack, chunks } = makeStreamingChannelFake();
    const sink = createReplySink(slack, "tok", CHANNEL);

    await sink.step("c1", "SlackHistory");
    await sink.step("c2", "SlackHistory");
    await sink.step("c3", "SlackHistory");
    await sink.stepDone("c1", "slack: SlackHistory");
    await sink.stepDone("c2");
    await sink.stepDone("c3");
    await sink.finish("done", "");

    expect(rows(chunks)).toEqual([
      "SlackHistory/SlackHistory/in_progress",
      "SlackHistory/SlackHistory ×2/in_progress",
      "SlackHistory/SlackHistory ×3/in_progress",
      // Still running while any of the three is: the row's status is the run's
      // state, not the last result's.
      "SlackHistory/SlackHistory ×3/in_progress",
      "SlackHistory/SlackHistory ×3/in_progress",
      "SlackHistory/SlackHistory ×3/complete",
    ]);
  });

  it("keeps a subagent's tools off the checklist", async () => {
    // The parent's own transfer row already stands for the whole hand-off, and
    // its result closes it when the child returns. Listing the child's calls as
    // well says the same thing again, once per call.
    const { slack, chunks } = makeStreamingChannelFake();
    const sink = createReplySink(slack, "tok", CHANNEL);

    await sink.step("c1", "dispatch_agents");
    await sink.step("c2", "researcher: SlackUser", { nested: true });
    await sink.step("c3", "researcher: FetchUrl", { nested: true });
    await sink.stepDone("c1", "dispatch_agents: researcher");
    await sink.finish("done", "");

    expect(rows(chunks)).toEqual([
      "dispatch_agents/dispatch_agents/in_progress",
      "dispatch_agents/dispatch_agents: researcher/complete",
    ]);
  });

  it("closes a step the run never finished, on the way out", async () => {
    // A timeout or a failed run leaves work in flight. A row left in_progress
    // on a finished message reads as a run that never came back.
    const { slack, chunks } = makeStreamingChannelFake();
    const sink = createReplySink(slack, "tok", CHANNEL);

    await sink.step("c1", "search");
    await sink.finish("gave up", ":warning: Agent run timed out");

    expect(rows(chunks)).toEqual(["search/search/in_progress", "search/search/complete"]);
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

  it("counts a repeat rather than re-sending the row unchanged", async () => {
    const { slack, chunks } = makeStreamingChannelFake();
    const sink = createReplySink(slack, "tok", CHANNEL);

    await sink.step("c1", "search");
    await sink.step("c2", "search");
    await sink.finish("done", "");

    expect(rows(chunks)).toEqual([
      "search/search/in_progress",
      "search/search ×2/in_progress",
      "search/search ×2/complete",
    ]);
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

describe("a checklist that would grow past reading", () => {
  it("shares one row once the cap is reached, and closes it at the end", async () => {
    // A checklist nobody can read is not a better report than a line that
    // moves — and each row costs two appends against Slack's stream limit.
    const { slack, chunks } = makeStreamingChannelFake();
    const sink = createReplySink(slack, "tok", CHANNEL);

    // Distinct tools, since same-named calls now collapse into one row.
    for (let index = 0; index < 30; index += 1) {
      await sink.step(`c${index}`, `tool-${index}`);
    }
    await sink.finish("done", "");

    const rows = chunks.map(({ chunk }) => chunk).filter((chunk) => chunk.type === "task_update");
    const ids = new Set(rows.map((row) => row.id));
    // 25 of their own, plus the one they overflow into.
    expect(ids.size).toBe(26);
    expect(ids.has("run-progress-more")).toBe(true);
    // The shared row keeps moving rather than freezing on the 26th tool, and
    // the run does not leave it spinning. Its count is the *other tools* that
    // landed on it — `×N` here would claim the run reached for tool-29 five
    // times, which it did not.
    const overflow = rows.filter((row) => row.id === "run-progress-more");
    expect(overflow.at(-1)).toEqual({
      type: "task_update",
      id: "run-progress-more",
      title: "tool-29 (+4 more)",
      status: "complete",
    });
  });
});

/**
 * The defect that shipped in v0.63.0 and was found in production: a channel run
 * finished, produced its answer, and the reader saw "is thinking…" forever.
 *
 * `chat.stopStream` refuses `markdown_text` and `chunks` on the same request, so
 * a close that carried both threw — after which the stream was never stopped and
 * the answer was never delivered. It needed *both* to fire, which is why it hid:
 * the text has to be non-empty (the last delta, unflushed because pushes are
 * paced at a second) and a row has to still be open.
 */
describe("closing a stream that still owes both text and rows", () => {
  it("delivers the answer", async () => {
    const { slack, appended, stopped, posted, chunks } = makeStreamingChannelFake();
    const sink = createReplySink(slack, "tok", CHANNEL);

    await sink.status("is thinking…");
    await sink.step("c1", "search");
    await sink.finish("here is the answer", ":warning: one binding was unusable");

    const delivered = [...appended, stopped[0]?.markdown_text ?? ""].join("");
    expect(delivered).toContain("here is the answer");
    expect(delivered).toContain("one binding was unusable");
    // The rows still closed — on their own append, ahead of the stop.
    expect(
      chunks.filter(({ at, chunk }) => at === "append" && chunk.type === "task_update"),
    ).not.toHaveLength(0);
    // And no fallback was needed, because nothing failed.
    expect(posted).toEqual([]);
  });

  it("posts what went missing when the close fails anyway", async () => {
    // Belt and braces for the same class of failure. This was silent for a
    // release: the run logged an error, the message stayed open, and a reader
    // had no way to tell a lost answer from a slow one.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { slack, posted } = makeStreamingChannelFake();
    slack.stopStream = async () => {
      throw new Error("Slack chat.stopStream failed: ratelimited");
    };
    const sink = createReplySink(slack, "tok", CHANNEL);

    await sink.status("is thinking…");
    await sink.push("here is ");
    await sink.finish("here is the answer", "");

    // Only the part Slack never took — `flushed` is not advanced past a failed
    // write, so a duplicated head would be its own defect.
    expect(posted).toEqual(["the answer"]);
  });
});

/**
 * Slack takes at most 12,000 characters in one `markdown_text`. That bites in
 * one specific place: the first append is deliberately unpaced, so it carries
 * everything the run has produced — and a refused append does not advance what
 * has been flushed, so every push after it re-sends the same oversized payload.
 * The answer never arrives and the retry never differs.
 */
describe("an answer longer than one write", () => {
  const LONG = "x".repeat(30_000);

  it("keeps surrogate pairs intact at initial and later append boundaries", async () => {
    const { slack, appended } = makeStreamingChannelFake();
    const sink = createReplySink(slack, "tok", CHANNEL);
    let clock = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => (clock += 5000));
    const text = `${"x".repeat(11_999)}😀${"y".repeat(11_997)}😀tail`;
    await sink.push(text);
    await sink.push(text);
    await sink.push(text);
    await sink.finish(text, "");
    expect(appended.every((part) => part.isWellFormed())).toBe(true);
    expect(appended.every((part) => part.length <= 12_000)).toBe(true);
    expect(appended.join("")).toBe(text);
  });

  it("sends it across several writes rather than one Slack refuses", async () => {
    const { slack, appended } = makeStreamingChannelFake();
    const sink = createReplySink(slack, "tok", CHANNEL);
    let clock = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => (clock += 5000));

    await sink.push(LONG);
    await sink.push(LONG);
    await sink.push(LONG);
    await sink.finish(LONG, "");

    // Every write is within the cap, and the whole answer still arrives.
    expect(appended.every((piece) => piece.length <= 12_000)).toBe(true);
    expect(appended.join("")).toBe(LONG);
  });

  it("splits what the close still owes in an assistant thread too", async () => {
    // A DM closes with one `markdown_text` rather than chunks, and one holds at
    // most 12,000 characters. The close is the last write there is, so a run
    // that arrives holding all of it had the rest cut off with nothing saying
    // so — the same case the chunked close beside it splits for.
    const { slack, appended, stopped, posted } = makeStreamingChannelFake();
    const sink = createReplySink(slack, "tok", DM);
    // The first push opens the stream and takes one write's worth; every append
    // after it is refused by the pacing clock, so the close is owed the rest.
    await sink.push(LONG);

    await sink.finish(LONG, "");

    const delivered = [...appended, stopped[0]?.markdown_text ?? "", ...posted].join("");
    expect(stopped).toHaveLength(1);
    expect((stopped[0]?.markdown_text ?? "").length).toBeLessThanOrEqual(12_000);
    expect(posted.every((piece) => piece.length <= 12_000)).toBe(true);
    expect(delivered).toBe(LONG);
  });

  it("splits what the close still owes", async () => {
    // A run whose every append was refused arrives here holding all of it.
    const { slack, appended, stopped } = makeStreamingChannelFake();
    const sink = createReplySink(slack, "tok", CHANNEL);
    await sink.status("is thinking…");

    await sink.finish(LONG, "");

    expect(stopped).toEqual([{}]);
    expect(appended.every((piece) => piece.length <= 12_000)).toBe(true);
    expect(appended.join("")).toBe(LONG);
  });
});

describe("a stream that failed to open and fell back to editing", () => {
  it("stays in the note it opened instead of orphaning it with a late stream", async () => {
    let clock = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const posted: string[] = [];
    const updates: Array<{ ts: string; text: string }> = [];
    const streamStarts: unknown[] = [];
    let refuseStream = true;
    const slack = {
      async startStream(_token: string, args: Record<string, unknown>) {
        if (refuseStream) {
          refuseStream = false;
          throw new Error("Slack chat.startStream failed: ratelimited");
        }
        streamStarts.push(args);
        return { ts: "200.1", channel: "C1" };
      },
      async postMessage(_token: string, args: { channel: string; text: string }) {
        posted.push(args.text);
        return { ts: "100.1", channel: args.channel };
      },
      async updateMessage(_token: string, args: { ts: string; text: string }) {
        updates.push({ ts: args.ts, text: args.text });
        return { ts: args.ts };
      },
    } as unknown as SlackClientPort;
    const sink = createReplySink(slack, "tok", CHANNEL);

    // The first status hits the stream refusal and posts the fallback note.
    await sink.status("is thinking…");
    expect(posted).toEqual([`_is thinking…_ ${INDICATOR}`]);

    // The next one must edit that note. A retried startStream succeeding here
    // would move the reply into a brand-new message and leave the note —
    // indicator and all — orphaned on screen.
    clock += 5000;
    await sink.status("is using search…");
    expect(streamStarts).toEqual([]);
    expect(updates).toEqual([{ ts: "100.1", text: `_is using search…_ ${INDICATOR}` }]);
  });
});

/**
 * The edited path has to end a message somewhere, and where it ends is the part
 * a reader sees. It would end nowhere: `chat.update` was sent the whole answer
 * every time, Slack refused it once it outgrew a message, and the run finished by
 * posting the remainder as error recovery — so the reply stopped at whatever
 * character the last accepted write had reached, and the message it stopped in
 * kept the loading indicator forever.
 */
describe("an edited answer longer than one Slack message", () => {
  /** 202 characters, ending where a message may be cut. */
  const PARAGRAPH = `${"문단".repeat(100)}\n\n`;
  const LONG = PARAGRAPH.repeat(30);

  /**
   * What each message ends up holding, in the order they were opened. The fake
   * gives the nth post the ts `100.n`, so an edit finds the message it edits.
   */
  function onScreen(
    posted: string[],
    updates: Array<{ ts: string; text: string }>,
  ): string[] {
    return posted.map(
      (text, index) => updates.filter((update) => update.ts === `100.${index + 1}`).at(-1)?.text ?? text,
    );
  }

  function tickingSink(fake: ReturnType<typeof makeChannelFake>) {
    let clock = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => (clock += 5000));
    return createReplySink(fake.slack, "tok", CHANNEL);
  }

  it("continues at a paragraph break rather than wherever the cap landed", async () => {
    const fake = makeChannelFake();
    const sink = tickingSink(fake);

    await sink.push(LONG);
    await sink.finish(LONG, "");

    const messages = onScreen(fake.posted, fake.updates);
    expect(messages.length).toBeGreaterThan(1);
    // Every message but the last ends where a paragraph does, and the answer is
    // exactly what the messages say together.
    for (const message of messages.slice(0, -1)) {
      expect(message.endsWith("\n\n")).toBe(true);
    }
    expect(messages.join("")).toBe(LONG);
  });

  it("takes the indicator off a message it has finished writing", async () => {
    const fake = makeChannelFake();
    const sink = tickingSink(fake);

    await sink.push(LONG);
    await sink.push(LONG);

    const messages = onScreen(fake.posted, fake.updates);
    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages.slice(0, -1)) {
      expect(message).not.toContain(INDICATOR);
    }
    // Only the one still being written says so.
    expect(messages.at(-1)?.endsWith(INDICATOR)).toBe(true);
  });

  it("leaves none of them holding it once the run is over", async () => {
    const fake = makeChannelFake();
    const sink = tickingSink(fake);

    await sink.push(LONG);
    await sink.finish(LONG, "");

    for (const message of onScreen(fake.posted, fake.updates)) {
      expect(message).not.toContain(INDICATOR);
    }
  });

  it("closes a code block it cut through and reopens it in the next message", async () => {
    const code = `설명:\n\n\`\`\`python\n${"print('hello world')\n".repeat(200)}\`\`\`\n`;
    const fake = makeChannelFake();
    const sink = tickingSink(fake);

    await sink.push(code);
    await sink.finish(code, "");

    const messages = onScreen(fake.posted, fake.updates);
    expect(messages.length).toBeGreaterThan(1);
    // Each message renders as a block on its own rather than one showing the
    // markup and the next showing the source.
    for (const message of messages) {
      expect(message.split("```").length % 2).toBe(1);
    }
    expect(messages[1]?.startsWith("```python\n")).toBe(true);
  });

  it("keeps a message it finished when the one continuing it cannot be posted", async () => {
    // The offset may only move past a piece once there is a message holding what
    // comes after it. Moving it when the piece was *written* left `messageStart`
    // ahead of the message `messageTs` still pointed at, and the next pass
    // overwrote a finished message with the text that followed it — losing a
    // message's worth of the answer with nothing said.
    const fake = makeChannelFake({ refusePost: 2 });
    const sink = tickingSink(fake);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await sink.push(LONG);
    // The second message is refused here, and the run carries on.
    await sink.push(LONG);
    await sink.finish(LONG, "");

    const messages = onScreen(fake.posted, fake.updates);
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.join("")).toBe(LONG);
  });

  it("cuts smaller when Slack refuses an edit as too long", async () => {
    // The cap is measured, not documented — a deployment whose real limit is
    // lower must not leave the answer stuck behind a payload that never fits.
    const fake = makeChannelFake({ refuseOver: 1200 });
    const sink = tickingSink(fake);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await sink.push(LONG);
    await sink.finish(LONG, "");

    const messages = onScreen(fake.posted, fake.updates);
    for (const message of messages) {
      expect(message.length).toBeLessThanOrEqual(1200);
    }
    expect(messages.join("")).toBe(LONG);
  });
});

describe("what a stream's chunks may not do", () => {
  it("sends no chunk at all when the close owes no text", async () => {
    // An empty `markdown_text` is not the same as none. The close carries
    // `chunks` only when it has some, so an empty one would make every healthy
    // run send a payload Slack was never sent before — and a refused
    // `stopStream` leaves the message open, saying "is thinking…" on a run that
    // has already finished.
    const { slack, appended } = makeStreamingChannelFake();
    const sink = createReplySink(slack, "tok", CHANNEL);
    let clock = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => (clock += 5000));

    await sink.push("the whole answer");
    await sink.finish("the whole answer", "");

    expect(appended.join("")).toBe("the whole answer");
    expect(appended).not.toContain("");
  });

  it("puts no fence of its own into the answer at a chunk boundary", async () => {
    // A chunk is a delta that concatenates, so anything added at a boundary
    // lands in the middle of the text. Closing and reopening a fence is right
    // for the edit path, whose pieces are separate messages, and wrong here.
    const fenced = `\`\`\`js\n${"const x = 1;\n".repeat(1_200)}\`\`\`\n`;
    const { slack, appended } = makeStreamingChannelFake();
    const sink = createReplySink(slack, "tok", CHANNEL);
    let clock = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => (clock += 5000));

    // The status opens the stream; the whole answer is then what the close owes.
    await sink.status("is thinking…");
    await sink.finish(fenced, "");

    expect(appended.length).toBeGreaterThan(1);
    expect(appended.join("")).toBe(fenced);
  });
});
