import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_CONCURRENT_FIRINGS } from "@/application/trigger/scanSchedules";
import { currentTenant } from "@/shared/tenantContext";

const { registry, background } = vi.hoisted(() => ({
  // No organizations by default: a single-tenant deployment, which is the shape
  // every existing one has. The multi-tenant cases drive this.
  registry: { organizations: [] as { id: string }[], fails: false },
  // The route hands its firings to `after()`, which the real runtime drains
  // after the response. Held here so a case can wait for it.
  background: { task: null as Promise<unknown> | null },
}));

vi.mock("next/server", () => ({
  after: (fn: () => unknown) => {
    background.task = Promise.resolve(fn());
  },
}));
vi.mock("@/lib/container", () => ({
  triggerRunnerDeps: {},
  organizationRepository: {
    list: async () => {
      if (registry.fails) {
        throw new Error("throttled");
      }
      return registry.organizations;
    },
  },
}));

const scanSchedules = vi.fn((_deps: unknown, _at: Date): Promise<unknown> => Promise.resolve(null));
const executeFiring = vi.fn((_deps: unknown, _firing: unknown, _input: unknown) =>
  Promise.resolve(),
);
vi.mock("@/application/trigger/scanSchedules", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/application/trigger/scanSchedules")>()),
  scanSchedules: (deps: unknown, at: Date) => scanSchedules(deps, at),
}));
vi.mock("@/application/trigger/runTrigger", () => ({
  executeFiring: (deps: unknown, firing: unknown, input: unknown) =>
    executeFiring(deps, firing, input),
}));

import { POST } from "@/app/api/triggers/scan/route";

const SUMMARY = {
  checked: 1,
  fired: 1,
  alreadyClaimed: 0,
  skipped: 0,
  repaired: 0,
  invalid: 0,
  errors: 0,
};
const FIRING = {
  status: "accepted",
  runId: "run-1",
  trigger: { kind: "schedule", projectName: "p", triggerId: "nightly", message: "go" },
};

function request(token?: string): Request {
  return new Request("http://localhost/api/triggers/scan", {
    method: "POST",
    ...(token ? { headers: { "x-scan-token": token } } : {}),
  });
}

beforeEach(() => {
  process.env.SCHEDULE_SCAN_TOKEN = "tick-token";
  registry.organizations = [];
  registry.fails = false;
  scanSchedules.mockResolvedValue({ summary: SUMMARY, firings: [FIRING] });
});

afterEach(() => {
  delete process.env.SCHEDULE_SCAN_TOKEN;
  vi.clearAllMocks();
});

describe("POST /api/triggers/scan", () => {
  it("answers 503 when no ticker is configured, without scanning", async () => {
    delete process.env.SCHEDULE_SCAN_TOKEN;
    const response = await POST(request("tick-token"));
    expect(response.status).toBe(503);
    expect(scanSchedules).not.toHaveBeenCalled();
  });

  it("refuses a missing or wrong token the same way every 401 reads", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const req of [request(), request("wrong")]) {
      const response = await POST(req);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "Unauthorized" });
    }
    expect(scanSchedules).not.toHaveBeenCalled();
    // A refused tick leaves a trace — it would otherwise 401 forever in silence.
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("survives the trailing newline a file-built Kubernetes Secret carries", async () => {
    process.env.SCHEDULE_SCAN_TOKEN = "tick-token\n";
    const response = await POST(request("tick-token"));
    expect(response.status).toBe(200);
  });

  it("scans, drives each firing in the background, and answers the summary", async () => {
    const response = await POST(request("tick-token"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(SUMMARY);
    expect(executeFiring).toHaveBeenCalledTimes(1);
    const [, firing, input] = executeFiring.mock.calls[0] ?? [];
    expect(firing).toBe(FIRING);
    expect(input).toEqual({ message: "go" });
  });
});

describe("every workspace", () => {
  it("scans the default one when the registry cannot be read", async () => {
    // Before this was fenced, one failed `TYPE#ORG` query returned 500 and
    // nothing fired that minute — for every workspace, including the
    // single-tenant deployment whose only possible answer was the empty list.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    registry.fails = true;
    const response = await POST(request("tick-token"));
    expect(response.status).toBe(200);
    expect(scanSchedules).toHaveBeenCalledTimes(1);
    expect(executeFiring).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("drives the workspaces that succeeded when one of them fails", async () => {
    // The firings already in hand were won with a claim, and a claim once won is
    // never offered again — so losing them to another workspace's failure loses
    // those occurrences for good, not until the next tick.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    registry.organizations = [{ id: "acme" }, { id: "globex" }];
    scanSchedules.mockImplementation(async () => {
      if (currentTenant() === "globex") {
        throw new Error("throttled");
      }
      return { summary: SUMMARY, firings: [FIRING] };
    });

    const response = await POST(request("tick-token"));
    expect(response.status).toBe(200);
    await background.task;
    // `default` and `acme` — globex contributed nothing, and cost nothing.
    expect(executeFiring).toHaveBeenCalledTimes(2);
    expect(await response.json()).toMatchObject({ fired: 2 });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("keeps one concurrency bound across them, not one each", async () => {
    // A per-workspace pool hands every workspace the whole budget, so twenty
    // workspaces sharing a 09:00 drive twenty times the limit on the pod that
    // served the tick — the exact fan-out the bound exists to prevent.
    registry.organizations = [{ id: "acme" }, { id: "globex" }];
    const many = Array.from({ length: MAX_CONCURRENT_FIRINGS * 2 }, (_, index) => ({
      ...FIRING,
      runId: `run-${index}`,
    }));
    scanSchedules.mockResolvedValue({ summary: SUMMARY, firings: many });

    let inFlight = 0;
    let peak = 0;
    executeFiring.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
    });

    await POST(request("tick-token"));
    await background.task;
    // Every workspace's firings ran — the bound is a bound, not a cap on work.
    expect(executeFiring).toHaveBeenCalledTimes(many.length * 3);
    expect(peak).toBeLessThanOrEqual(MAX_CONCURRENT_FIRINGS);
  });
});
