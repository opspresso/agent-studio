import { describe, expect, it, vi } from "vitest";
import { withTraceExport } from "@/infrastructure/telemetry/withTraceExport";
import type { Trace } from "@/domain/trace/types";
import type { TraceRepository } from "@/domain/trace/repository";

function traceFixture(): Trace {
  return {
    traceId: "t-1",
    projectName: "demo",
    versionName: "1",
    projectType: "agent",
    status: "completed",
    spans: [],
    startedAt: "2026-08-09T00:00:00.000Z",
    endedAt: "2026-08-09T00:00:01.000Z",
    durationMs: 1000,
    createdAt: "2026-08-09T00:00:01.000Z",
  };
}

function fakeRepository(calls: string[]): TraceRepository {
  return {
    put: async () => {
      calls.push("put");
    },
    get: async () => null,
    listByProject: async () => [],
  };
}

describe("withTraceExport", () => {
  it("persists before exporting", async () => {
    const calls: string[] = [];
    const decorated = withTraceExport(fakeRepository(calls), () => {
      calls.push("export");
    });

    await decorated.put(traceFixture());

    expect(calls).toEqual(["put", "export"]);
  });

  it("swallows an export failure — the row is the record", async () => {
    const calls: string[] = [];
    const decorated = withTraceExport(fakeRepository(calls), () => {
      throw new Error("collector down");
    });

    await expect(decorated.put(traceFixture())).resolves.toBeUndefined();
    expect(calls).toEqual(["put"]);
  });

  it("does not export when persistence failed", async () => {
    const exportTrace = vi.fn();
    const failing: TraceRepository = {
      put: async () => {
        throw new Error("storage down");
      },
      get: async () => null,
      listByProject: async () => [],
    };
    const decorated = withTraceExport(failing, exportTrace);

    await expect(decorated.put(traceFixture())).rejects.toThrow("storage down");
    expect(exportTrace).not.toHaveBeenCalled();
  });
});
