import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentWorkerPool, DOCUMENT_JOB_TIMEOUT_MS, MAX_DOCUMENT_WORKERS, MAX_QUEUED_DOCUMENT_JOBS } from "@/infrastructure/documents/workerPool";
import { MAX_DOCUMENT_BYTES } from "@/domain/llm/documentLimits";

class Child extends EventEmitter {
  pid: number | undefined = 123;
  send = vi.fn();
  kill = vi.fn(() => true);
}
const input = { bytes: Buffer.from("hello"), mimeType: "text/plain", name: "a.txt", maxChars: 100 };
function setup() {
  const children: Child[] = [];
  const spawn = vi.fn(() => { const child = new Child(); children.push(child); return child as unknown as ChildProcess; });
  return { pool: new DocumentWorkerPool(spawn), children, spawn };
}
function reply(child: Child) {
  child.emit("message", { ok: true, result: { text: "hello" } });
  child.emit("exit", 0);
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("document worker pool", () => {
  it("counts workbook input as UTF-8 bytes before spawning", async () => {
    const spawn = vi.fn((): ChildProcess => { throw new Error("must not spawn"); });
    const pool = new DocumentWorkerPool(spawn);
    await expect(pool.execute("create", {
      format: "xlsx", title: "test", created: "2026-09-07T00:00:00.000Z",
      sheets: [{ name: "Sheet", rows: [["가".repeat(Math.floor(MAX_DOCUMENT_BYTES / 3) + 1)]] }],
    })).rejects.toThrow("Workbook input exceeds the byte budget");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("bounds concurrency and releases slots only after process exit", async () => {
    const { pool, children, spawn } = setup();
    const jobs = Array.from({ length: MAX_DOCUMENT_WORKERS + MAX_QUEUED_DOCUMENT_JOBS }, () => pool.execute("extract", input));
    expect(spawn).toHaveBeenCalledTimes(MAX_DOCUMENT_WORKERS);
    await expect(pool.execute("extract", input)).rejects.toThrow("busy");
    children[0]!.emit("message", { ok: true, result: { text: "hello" } });
    expect(await jobs[0]).toEqual({ text: "hello" });
    expect(children[0]!.kill).toHaveBeenCalledWith("SIGKILL");
    expect(spawn).toHaveBeenCalledTimes(MAX_DOCUMENT_WORKERS);
    children[0]!.emit("exit", 0);
    expect(spawn).toHaveBeenCalledTimes(MAX_DOCUMENT_WORKERS + 1);
    for (let index = 1; index < children.length; index++) reply(children[index]!);
    await Promise.all(jobs);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels queued work without spawning it and keeps active slots until exit", async () => {
    const { pool, children } = setup();
    const first = pool.execute("extract", input);
    const second = pool.execute("extract", input);
    const controller = new AbortController();
    const queued = pool.execute("extract", input, controller.signal).catch((error: unknown) => error);
    const reason = new Error("cancel requested");
    controller.abort(reason);
    expect(await queued).toBe(reason);
    reply(children[0]!); reply(children[1]!);
    await Promise.all([first, second]);
    expect(children).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("includes queue time in the deadline and terminates active processes", async () => {
    const { pool, children } = setup();
    const jobs = Array.from({ length: 3 }, () => pool.execute("extract", input).catch((error: unknown) => error));
    await vi.advanceTimersByTimeAsync(DOCUMENT_JOB_TIMEOUT_MS);
    for (const error of await Promise.all(jobs)) expect(String(error)).toContain("deadline");
    expect(children).toHaveLength(2);
    expect(children.every((child) => child.kill.mock.calls.length === 1)).toBe(true);
    children.forEach((child) => child.emit("exit", null, "SIGKILL"));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves active cancellation and handles premature exits", async () => {
    const { pool, children } = setup();
    const controller = new AbortController();
    const cancelled = pool.execute("extract", input, controller.signal).catch((error: unknown) => error);
    const reason = new Error("stop");
    controller.abort(reason);
    expect(await cancelled).toBe(reason);
    expect(children[0]!.kill).toHaveBeenCalledOnce();
    children[0]!.emit("exit", null);
    const failed = pool.execute("extract", input).catch((error: unknown) => error);
    children[1]!.emit("exit", 1);
    expect(String(await failed)).toContain("exited before returning");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("handles spawn failures and rejects oversize input before spawning", async () => {
    const spawn = vi.fn((): ChildProcess => { throw new Error("spawn failed"); });
    const pool = new DocumentWorkerPool(spawn);
    await expect(pool.execute("extract", input)).rejects.toThrow("Could not start");
    await expect(pool.execute("extract", { ...input, bytes: new Uint8Array(MAX_DOCUMENT_BYTES + 1) })).rejects.toThrow("byte limit");
    expect(spawn).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes controlled worker errors and rejects malformed replies", async () => {
    const { pool, children } = setup();
    const first = pool.execute("extract", input).catch((error: unknown) => error);
    children[0]!.emit("message", { ok: false, error: "The document is password-protected" });
    expect(String(await first)).toContain("password-protected");
    children[0]!.emit("exit", 0);
    const second = pool.execute("extract", input).catch((error: unknown) => error);
    children[1]!.emit("message", null);
    expect(String(await second)).toContain("Invalid document worker response");
    children[1]!.emit("exit", 0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
