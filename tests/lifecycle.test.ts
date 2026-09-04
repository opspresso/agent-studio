import { afterAll, describe, expect, it } from "vitest";
import {
  beginShutdown,
  isShuttingDown,
  onShutdown,
  registerShutdownSignals,
} from "@/shared/lifecycle";

afterAll(() => {
  process.removeListener("SIGTERM", beginShutdown);
  process.removeListener("SIGINT", beginShutdown);
});

describe("lifecycle", () => {
  it("starts not shutting down", () => {
    expect(isShuttingDown()).toBe(false);
  });

  it("registers SIGTERM/SIGINT handlers that mark the instance unready", () => {
    registerShutdownSignals();
    expect(process.listeners("SIGTERM")).toContain(beginShutdown);
    expect(process.listeners("SIGINT")).toContain(beginShutdown);
  });

  it("is idempotent — the handler is attached once", () => {
    registerShutdownSignals();
    expect(process.listeners("SIGTERM").filter((l) => l === beginShutdown)).toHaveLength(1);
  });

  it("flips readiness once and runs shutdown hooks once", async () => {
    let hooks = 0;
    onShutdown(() => {
      hooks += 1;
    });

    beginShutdown();
    beginShutdown();
    await Promise.resolve();

    beginShutdown();
    expect(isShuttingDown()).toBe(true);
    expect(hooks).toBe(1);
  });
});
