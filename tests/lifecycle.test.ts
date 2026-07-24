import { afterAll, describe, expect, it } from "vitest";
import { beginShutdown, isShuttingDown, registerShutdownSignals } from "@/lib/lifecycle";

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

  it("flips readiness to unready when the shutdown handler fires", () => {
    beginShutdown();
    expect(isShuttingDown()).toBe(true);
  });
});
