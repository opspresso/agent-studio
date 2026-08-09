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

  it("keeps the reads of a class-instance repository", async () => {
    // The production repository is a class instance: its methods live on the
    // prototype, where a spread cannot see them. A decorator built by spread
    // would satisfy the type and still lose everything but `put`.
    class ClassRepository implements TraceRepository {
      async put(): Promise<void> {}
      async get(): Promise<Trace | null> {
        return traceFixture();
      }
      async listByProject(): Promise<Trace[]> {
        return [traceFixture()];
      }
    }
    const decorated = withTraceExport(new ClassRepository(), () => {});

    await expect(decorated.get("t-1")).resolves.toMatchObject({ traceId: "t-1" });
    await expect(decorated.listByProject("demo")).resolves.toHaveLength(1);
  });
});
