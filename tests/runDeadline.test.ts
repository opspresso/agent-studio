import { describe, expect, it, vi } from "vitest";
import { parseMaxRunDuration, runDeadlineExceeded, withRunDeadline } from "@/shared/runDeadline";
import { runEnding } from "@/application/run/runDeadline";
import { RunDeadlineError } from "@/application/errors";

describe("parseMaxRunDuration", () => {
  it("defaults when unset or blank", () => {
    expect(parseMaxRunDuration(undefined)).toBe(600_000);
    expect(parseMaxRunDuration("")).toBe(600_000);
    expect(parseMaxRunDuration("   ")).toBe(600_000);
  });

  it("accepts a positive, in-range integer", () => {
    expect(parseMaxRunDuration("300000")).toBe(300_000);
    expect(parseMaxRunDuration("2147483647")).toBe(2_147_483_647);
  });

  it("falls back to the default for values AbortSignal.timeout would reject", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const bad of ["-1", "0", "Infinity", "NaN", "1.5", "abc", "2147483648", "9999999999999"]) {
        expect(parseMaxRunDuration(bad)).toBe(600_000);
      }
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("which limit stopped a run", () => {
  it("says nothing stopped it while the run is still going", () => {
    const caller = new AbortController();
    expect(runDeadlineExceeded(withRunDeadline(caller.signal))).toBe(false);
    expect(runDeadlineExceeded(undefined)).toBe(false);
  });

  it("does not read a caller leaving as the deadline", () => {
    const caller = new AbortController();
    const run = withRunDeadline(caller.signal);
    caller.abort();
    expect(run.aborted).toBe(true);
    expect(runDeadlineExceeded(run)).toBe(false);
  });

  it("does not read a caller's own timeout as the deadline", () => {
    // The Slack surface caps a run at three minutes by passing a timeout as the
    // caller signal, so the abort *reason* is a TimeoutError there too — which
    // is why the deadline is identified by the signal, not by the reason.
    const caller = new AbortController();
    const run = withRunDeadline(caller.signal);
    caller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    expect(runDeadlineExceeded(run)).toBe(false);
  });

  it("recognises its own deadline, however the run signal was composed", () => {
    const deadline = new AbortController();
    const caller = new AbortController();
    const withCaller = withRunDeadline(caller.signal, deadline.signal);
    const alone = withRunDeadline(undefined, deadline.signal);
    deadline.abort();
    expect(runDeadlineExceeded(withCaller)).toBe(true);
    expect(runDeadlineExceeded(alone)).toBe(true);
  });
});

describe("runEnding", () => {
  const original = new Error("The operation was aborted due to timeout");

  it("leaves an ordinary failure alone", () => {
    const caller = new AbortController();
    const run = withRunDeadline(caller.signal);
    expect(runEnding(original, { run, caller: caller.signal })).toBe(original);
  });

  it("gives the deadline words of its own, and a status a route can map", () => {
    const deadline = new AbortController();
    const caller = new AbortController();
    const run = withRunDeadline(caller.signal, deadline.signal);
    deadline.abort();

    const ending = runEnding(original, { run, caller: caller.signal });
    expect(ending).toBeInstanceOf(RunDeadlineError);
    expect((ending as RunDeadlineError).status).toBe(504);
    expect((ending as RunDeadlineError).message).toMatch(/^This run was stopped after \d+ seconds/);
  });

  it("keeps a caller's cancellation a cancellation when both fired", () => {
    // Otherwise a reader who navigated away would be recorded as a failed run
    // and counted as one, on the strength of a deadline that fired in the same
    // tick and that nobody was waiting for.
    const deadline = new AbortController();
    const caller = new AbortController();
    const run = withRunDeadline(caller.signal, deadline.signal);
    caller.abort();
    deadline.abort();
    expect(runEnding(original, { run, caller: caller.signal })).toBe(original);
  });
});
