import { afterEach, describe, expect, it, vi } from "vitest";
import { withCheckLifecycle } from "../scripts/check-lifecycle";

afterEach(() => vi.restoreAllMocks());

describe("check fixture lifecycle", () => {
  it("releases dependent fixtures before their owners and returns after cleanup", async () => {
    const released: string[] = [];
    const pool = { open: true };
    const value = await withCheckLifecycle(async cleanup => {
      cleanup(() => { pool.open = false; released.push("pool"); });
      cleanup(async () => {
        await Promise.resolve();
        expect(pool.open).toBe(true);
        released.push("settings");
      });
      cleanup(() => { released.push("session"); });
      return "complete";
    });
    expect(value).toBe("complete");
    expect(released).toEqual(["session", "settings", "pool"]);
  });

  it("preserves the original failure while attempting every cleanup and reporting their errors", async () => {
    const original = new Error("assertion failed");
    const cleanupFailure = new Error("release failed");
    const reported = vi.spyOn(console, "error").mockImplementation(() => {});
    const released: string[] = [];
    const result = withCheckLifecycle(async cleanup => {
      cleanup(() => { released.push("pool"); });
      cleanup(() => { released.push("settings"); throw cleanupFailure; });
      cleanup(() => { released.push("session"); });
      throw original;
    });
    await expect(result).rejects.toBe(original);
    expect(released).toEqual(["session", "settings", "pool"]);
    expect(reported).toHaveBeenCalledExactlyOnceWith("CHECK CLEANUP FAILURE:", expect.any(AggregateError));
    expect((reported.mock.calls[0]![1] as AggregateError).errors).toEqual([cleanupFailure]);
  });

  it("rejects a completed check when cleanup failed", async () => {
    const first = new Error("storage failed");
    const second = new Error("settings failed");
    const released = vi.fn();
    const result = withCheckLifecycle(async cleanup => {
      cleanup(released);
      cleanup(() => { throw second; });
      cleanup(async () => { throw first; });
      return "complete";
    });
    await expect(result).rejects.toMatchObject({ errors: [first, second] });
    expect(released).toHaveBeenCalledOnce();
  });
});
