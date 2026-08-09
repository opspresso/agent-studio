import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ after: (fn: () => unknown) => fn() }));

const { syncPluginsFromRepo, lastPluginSync, pluginsRepoHeadSha, repoConfig } = vi.hoisted(() => ({
  syncPluginsFromRepo: vi.fn(),
  lastPluginSync: vi.fn(),
  pluginsRepoHeadSha: vi.fn(),
  repoConfig: {
    value: { repo: "opspresso/agent-plugins", branch: "main", token: "gh-token" } as {
      repo: string | undefined;
      branch: string;
      token: string | undefined;
    },
  },
}));

vi.mock("@/lib/container", () => ({ syncPluginsFromRepo, lastPluginSync, pluginsRepoHeadSha }));
vi.mock("@/lib/runtime-settings", () => ({
  getPluginsRepoConfig: vi.fn(async () => repoConfig.value),
}));

import { POST } from "@/app/api/plugins/sync/scan/route";

const EMPTY_REPORT = {
  repo: "opspresso/agent-plugins",
  commitSha: "sha-1",
  plugins: [],
  skipped: [],
  orphanedPlugins: [],
  removedPlugins: [],
};

function request(token?: string): Request {
  return new Request("http://localhost/api/plugins/sync/scan", {
    method: "POST",
    ...(token ? { headers: { "x-scan-token": token } } : {}),
  });
}

beforeEach(() => {
  process.env.SCHEDULE_SCAN_TOKEN = "tick-token";
  repoConfig.value = { repo: "opspresso/agent-plugins", branch: "main", token: "gh-token" };
  syncPluginsFromRepo.mockResolvedValue(EMPTY_REPORT);
  pluginsRepoHeadSha.mockResolvedValue("sha-2");
  lastPluginSync.mockResolvedValue(null);
});

afterEach(() => {
  delete process.env.SCHEDULE_SCAN_TOKEN;
  vi.clearAllMocks();
});

describe("POST /api/plugins/sync/scan", () => {
  it("answers 503 with no tick token, without syncing", async () => {
    delete process.env.SCHEDULE_SCAN_TOKEN;
    expect((await POST(request("tick-token"))).status).toBe(503);
    expect(syncPluginsFromRepo).not.toHaveBeenCalled();
  });

  it("refuses a wrong or missing token", async () => {
    expect((await POST(request("wrong"))).status).toBe(401);
    expect((await POST(request())).status).toBe(401);
    expect(syncPluginsFromRepo).not.toHaveBeenCalled();
  });

  it("answers 503 when the repo is not configured", async () => {
    repoConfig.value = { repo: undefined, branch: "main", token: "gh-token" };
    expect((await POST(request("tick-token"))).status).toBe(503);
    expect(syncPluginsFromRepo).not.toHaveBeenCalled();
  });

  it("runs the sync as the scheduler when the head moved", async () => {
    lastPluginSync.mockResolvedValue({
      repo: "opspresso/agent-plugins",
      report: { ...EMPTY_REPORT, commitSha: "sha-1" },
      actorEmail: "admin@example.com",
      finishedAt: "2026-01-01T00:00:00.000Z",
    });
    const res = await POST(request("tick-token"));
    expect(res.status).toBe(202);
    expect(syncPluginsFromRepo).toHaveBeenCalledWith(repoConfig.value, "scheduler");
  });

  it("skips the snapshot entirely when the head matches the last clean report", async () => {
    pluginsRepoHeadSha.mockResolvedValue("sha-1");
    lastPluginSync.mockResolvedValue({
      repo: "opspresso/agent-plugins",
      report: { ...EMPTY_REPORT, commitSha: "sha-1" },
      actorEmail: "admin@example.com",
      finishedAt: "2026-01-01T00:00:00.000Z",
    });
    const res = await POST(request("tick-token"));
    expect(await res.json()).toEqual({ started: false, upToDate: true });
    expect(syncPluginsFromRepo).not.toHaveBeenCalled();
  });

  it("re-runs an unchanged head whose last report carried a write failure", async () => {
    pluginsRepoHeadSha.mockResolvedValue("sha-1");
    lastPluginSync.mockResolvedValue({
      repo: "opspresso/agent-plugins",
      report: {
        ...EMPTY_REPORT,
        commitSha: "sha-1",
        skipped: [{ name: "boom", reason: "write-failed", detail: "storage down" }],
      },
      actorEmail: "admin@example.com",
      finishedAt: "2026-01-01T00:00:00.000Z",
    });
    const res = await POST(request("tick-token"));
    expect(res.status).toBe(202);
    expect(syncPluginsFromRepo).toHaveBeenCalled();
  });

  it("falls through to the full sync when the head check itself fails", async () => {
    pluginsRepoHeadSha.mockRejectedValue(new Error("github down"));
    const res = await POST(request("tick-token"));
    expect(res.status).toBe(202);
    expect(syncPluginsFromRepo).toHaveBeenCalled();
  });
});
