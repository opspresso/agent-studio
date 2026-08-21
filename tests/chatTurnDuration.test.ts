import { describe, expect, it } from "vitest";
import { answerDurations } from "@/app/chats/_lib/turnDuration";
import { formatDuration, formatSeconds } from "@/app/_lib/duration";
import { translator } from "@/app/_i18n/translate";
import type { ChatMessage } from "@/domain/chat/types";

const t = translator("en");

function user(seq: number, createdAt: string): ChatMessage {
  return { chatId: "c1", seq, role: "user", content: "hi", createdAt };
}

function assistant(seq: number, createdAt: string): ChatMessage {
  return { chatId: "c1", seq, role: "assistant", content: "hello", createdAt };
}

function tool(seq: number, createdAt: string): ChatMessage {
  return {
    chatId: "c1",
    seq,
    role: "tool",
    content: "result",
    toolCallId: "call-1",
    createdAt,
  };
}

describe("answerDurations", () => {
  it("measures from the question to the answer", () => {
    const durations = answerDurations([
      user(1, "2026-08-21T00:00:00.000Z"),
      assistant(2, "2026-08-21T00:00:12.000Z"),
    ]);
    expect(durations.get(2)).toBe(12_000);
  });

  /**
   * The tool rows are written in the same instant as the assistant message that
   * follows them, so a pairing that took "the message before" rather than "the
   * user turn before" would report every answer with tool traffic as instant.
   */
  it("passes over the tool rows stored between the two", () => {
    const durations = answerDurations([
      user(1, "2026-08-21T00:00:00.000Z"),
      tool(2, "2026-08-21T00:00:30.000Z"),
      tool(3, "2026-08-21T00:00:30.000Z"),
      assistant(4, "2026-08-21T00:00:30.000Z"),
    ]);
    expect(durations.get(4)).toBe(30_000);
  });

  it("pairs each turn with its own question", () => {
    const durations = answerDurations([
      user(1, "2026-08-21T00:00:00.000Z"),
      assistant(2, "2026-08-21T00:00:05.000Z"),
      user(3, "2026-08-21T00:01:00.000Z"),
      assistant(4, "2026-08-21T00:01:20.000Z"),
    ]);
    expect([...durations.entries()]).toEqual([
      [2, 5_000],
      [4, 20_000],
    ]);
  });

  it("reads by seq, not by the order the list happens to be in", () => {
    const durations = answerDurations([
      assistant(2, "2026-08-21T00:00:09.000Z"),
      user(1, "2026-08-21T00:00:00.000Z"),
    ]);
    expect(durations.get(2)).toBe(9_000);
  });

  it("says nothing for an answer whose question is not in the list", () => {
    expect(answerDurations([assistant(2, "2026-08-21T00:00:12.000Z")]).has(2)).toBe(false);
  });

  it("says nothing for a second answer to the same question", () => {
    const durations = answerDurations([
      user(1, "2026-08-21T00:00:00.000Z"),
      assistant(2, "2026-08-21T00:00:05.000Z"),
      assistant(3, "2026-08-21T00:00:09.000Z"),
    ]);
    expect(durations.has(3)).toBe(false);
  });

  /** Clocks that disagree produce a negative gap; "-3s" is worse than silence. */
  it("says nothing when the answer is stamped before the question", () => {
    const durations = answerDurations([
      user(1, "2026-08-21T00:00:10.000Z"),
      assistant(2, "2026-08-21T00:00:07.000Z"),
    ]);
    expect(durations.has(2)).toBe(false);
  });

  it("says nothing when a timestamp cannot be read", () => {
    const durations = answerDurations([user(1, ""), assistant(2, "2026-08-21T00:00:07.000Z")]);
    expect(durations.has(2)).toBe(false);
  });
});

describe("formatSeconds", () => {
  it("counts whole seconds under a minute", () => {
    expect(formatSeconds(0, t)).toBe("0s");
    expect(formatSeconds(42.9, t)).toBe("42s");
    expect(formatSeconds(59, t)).toBe("59s");
  });

  it("splits into minutes and seconds from a minute up", () => {
    expect(formatSeconds(60, t)).toBe("1m 0s");
    expect(formatSeconds(83, t)).toBe("1m 23s");
    expect(formatSeconds(724, t)).toBe("12m 4s");
  });

  /** A stopwatch truncates: showing `1s` before a second has passed is a lie. */
  it("truncates rather than rounds", () => {
    expect(formatSeconds(0.9, t)).toBe("0s");
  });

  it("never counts backwards", () => {
    expect(formatSeconds(-5, t)).toBe("0s");
  });
});

describe("formatDuration", () => {
  /** A measurement being reported, unlike the stopwatch: 1.9s reads as 2s. */
  it("rounds a finished measurement", () => {
    expect(formatDuration(1_900, t)).toBe("2s");
    expect(formatDuration(12_400, t)).toBe("12s");
  });

  it("carries into minutes at the boundary", () => {
    expect(formatDuration(59_600, t)).toBe("1m 0s");
  });

  it("speaks the reader's language", () => {
    expect(formatDuration(12_000, translator("ko"))).toBe("12초");
    expect(formatDuration(83_000, translator("ko"))).toBe("1분 23초");
  });
});
