import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/container", () => ({ readinessReport: vi.fn() }));

const { GET: readyGet } = await import("@/app/api/ready/route");
const { GET: healthGet } = await import("@/app/api/health/route");
const { beginShutdown } = await import("@/shared/lifecycle");
const { readinessReport } = await import("@/lib/container");
const readinessMock = readinessReport as ReturnType<typeof vi.fn>;

describe("GET /api/ready", () => {
  it("returns 200 when downstreams are reachable", async () => {
    readinessMock.mockResolvedValue({ ready: true, checks: { db: "ok", llm: "ok" } });
    const res = await readyGet();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ready: true });
  });

  it("returns 503 when a downstream is unreachable", async () => {
    readinessMock.mockResolvedValue({ ready: false, checks: { db: "unreachable", llm: "ok" } });
    const res = await readyGet();
    expect(res.status).toBe(503);
  });

  it("returns 503 and skips probing once draining", async () => {
    readinessMock.mockClear();
    beginShutdown();
    const res = await readyGet();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ draining: true });
    expect(readinessMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/health", () => {
  it("stays 200 — liveness is independent of downstream state", () => {
    const res = healthGet();
    expect(res.status).toBe(200);
  });
});
