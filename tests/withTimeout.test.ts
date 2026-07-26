import { afterEach, describe, expect, it, vi } from "vitest";
import { TimeoutError, withTimeout } from "@/shared/withTimeout";

describe("withTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves when the operation settles before the deadline", async () => {
    await expect(withTimeout(Promise.resolve("done"), 1000)).resolves.toBe("done");
  });

  it("propagates the operation's own rejection", async () => {
    await expect(withTimeout(Promise.reject(new Error("boom")), 1000)).rejects.toThrow("boom");
  });

  it("rejects with TimeoutError when the operation hangs past the deadline", async () => {
    vi.useFakeTimers();
    const hang = new Promise<never>(() => {});
    const raced = withTimeout(hang, 2000);
    const assertion = expect(raced).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
  });
});
