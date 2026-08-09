import { beforeEach, describe, expect, it, vi } from "vitest";

const { syncPluginsFromRepo, pluginUseCases, repoConfig } = vi.hoisted(() => ({
  syncPluginsFromRepo: vi.fn(),
  pluginUseCases: { list: vi.fn() },
  repoConfig: {
    value: { repo: "opspresso/agent-plugins", branch: "main", token: "gh-token" } as {
      repo: string | undefined;
      branch: string;
      token: string | undefined;
    },
  },
}));

vi.mock("@/lib/session", () => ({
  withAuth:
    (handler: (...args: any[]) => unknown) =>
    (...args: any[]) =>
      handler(...args),
  withAdminAuth:
    (handler: (user: unknown, ...args: any[]) => unknown) =>
    (...args: any[]) =>
      handler({ id: "u1", email: "admin@example.com", name: "A", image: null }, ...args),
}));
vi.mock("@/lib/container", () => ({ syncPluginsFromRepo, pluginUseCases }));
vi.mock("@/lib/runtime-settings", () => ({
  getPluginsRepoConfig: vi.fn(async () => repoConfig.value),
}));

const syncRoute = await import("@/app/api/plugins/sync/route");
const listRoute = await import("@/app/api/plugins/route");

const post = (body: unknown) =>
  syncRoute.POST(
    new Request("https://studio.example.com/api/plugins/sync", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  repoConfig.value = { repo: "opspresso/agent-plugins", branch: "main", token: "gh-token" };
  syncPluginsFromRepo.mockResolvedValue({ repo: "opspresso/agent-plugins", plugins: [] });
});

describe("GET /api/plugins/sync", () => {
  it("reports whether the sync is configured, without the token", async () => {
    const res = await syncRoute.GET();
    expect(await res.json()).toEqual({
      configured: true,
      repo: "opspresso/agent-plugins",
      branch: "main",
    });
  });

  it("says unconfigured when the repo or token is missing", async () => {
    repoConfig.value = { repo: undefined, branch: "main", token: "gh-token" };
    const res = await syncRoute.GET();
    expect(await res.json()).toEqual({ configured: false, repo: null, branch: "main" });
  });
});

describe("POST /api/plugins/sync", () => {
  it("forwards the kind-qualified selection and the caller's email", async () => {
    const selection = {
      overwrite: { skills: ["gitops"], mcpServers: ["argocd"] },
      remove: { plugins: ["retired"] },
    };
    const res = await post(selection);
    expect(res.status).toBe(200);
    expect(syncPluginsFromRepo).toHaveBeenCalledWith(
      repoConfig.value,
      "admin@example.com",
      selection,
    );
  });

  it("503s when unconfigured, before any fetch", async () => {
    repoConfig.value = { repo: "opspresso/agent-plugins", branch: "main", token: undefined };
    const res = await post({});
    expect(res.status).toBe(503);
    expect(syncPluginsFromRepo).not.toHaveBeenCalled();
  });

  it("400s on a malformed selection without running the sync", async () => {
    const res = await post({ overwrite: { skills: "gitops" } });
    expect(res.status).toBe(400);
    expect(syncPluginsFromRepo).not.toHaveBeenCalled();
  });

  it("400s on a selection over the name cap", async () => {
    const res = await post({ remove: { skills: Array.from({ length: 501 }, (_, i) => `s${i}`) } });
    expect(res.status).toBe(400);
  });

  it("answers 502 for an upstream failure — theirs, not ours", async () => {
    syncPluginsFromRepo.mockRejectedValue(new Error("GitHub /repos/x failed: 500"));
    const res = await post({});
    expect(res.status).toBe(502);
  });
});

describe("GET /api/plugins", () => {
  it("returns the installed plugins", async () => {
    const rows = [{ name: "devops", skills: ["gitops"], mcpServers: ["argocd"] }];
    pluginUseCases.list.mockResolvedValue(rows);
    const res = await listRoute.GET();
    expect(await res.json()).toEqual(rows);
  });
});
