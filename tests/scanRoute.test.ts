import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ after: (fn: () => unknown) => fn() }));
vi.mock("@/lib/container", () => ({
  triggerRunnerDeps: {},
  // No organizations: a single-tenant deployment, which is the shape every
  // existing one has. The multi-tenant fan-out has its own case below.
  organizationRepository: { list: async () => [] },
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
