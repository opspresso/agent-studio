import { describe, expect, it, vi } from "vitest";
import { waitWithSignal } from "@/shared/waitWithSignal";

describe("waitWithSignal", () => {
  it("does not start work cancelled before dispatch", async () => {
    const reason = new Error("Stopped");
    const start = vi.fn(() => "unreachable");
    await expect(waitWithSignal(start, AbortSignal.abort(reason))).rejects.toBe(reason);
    const controller = new AbortController();
    const pending = waitWithSignal(start, controller.signal);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(start).not.toHaveBeenCalled();
  });

  it.each(["return", "throw", "reject"] as const)("settles %s and removes the abort listener", async mode => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const failure = new Error("Failed");
    const pending = waitWithSignal(() => {
      if (mode === "throw") throw failure;
      if (mode === "reject") return Promise.reject(failure);
      return "answer";
    }, controller.signal);
    if (mode === "return") await expect(pending).resolves.toBe("answer");
    else await expect(pending).rejects.toBe(failure);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it.each(["resolve", "reject"] as const)("stops waiting but handles a late %s", async outcome => {
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const operation = Promise.withResolvers<string>();
    const pending = waitWithSignal(() => { entered.resolve(); return operation.promise; }, controller.signal);
    await entered.promise;
    const reason = new Error("Stopped");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    if (outcome === "resolve") operation.resolve("late answer");
    else operation.reject(new Error("Late transport error"));
  });

  it("handles a rejected operation that synchronously aborts during dispatch", async () => {
    const controller = new AbortController();
    const reason = new Error("Stopped");
    await expect(waitWithSignal(() => {
      controller.abort(reason);
      return Promise.reject(new Error("Transport error"));
    }, controller.signal)).rejects.toBe(reason);
  });
});
