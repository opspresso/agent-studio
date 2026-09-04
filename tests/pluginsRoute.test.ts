import { beforeEach, describe, expect, it, vi } from "vitest";

const { syncPluginsFromRepo, pluginUseCases, lastPluginSync, repoConfig } = vi.hoisted(() => ({
  syncPluginsFromRepo: vi.fn(),
  pluginUseCases: { list: vi.fn(), get: vi.fn() },
  lastPluginSync: vi.fn(async () => null),
  repoConfig: {
    value: { repo: "opspresso/agent-plugins", branch: "main", token: "gh-token" } as {
      repo: string | undefined;
      branch: string;
      token: string | undefined;
    },
  },
}));

vi.mock("@/lib/session", () => ({
  withMemberAuth:
    (handler: (user: unknown, ...args: any[]) => unknown) =>
    (...args: any[]) =>
      handler({ id: "u1", email: "user@example.com", name: "U", image: null }, ...args),
  withAdminAuth:
    (handler: (user: unknown, ...args: any[]) => unknown) =>
    (...args: any[]) =>
      handler({ id: "u1", email: "admin@example.com", name: "A", image: null }, ...args),
}));
vi.mock("@/lib/container", () => ({ syncPluginsFromRepo, pluginUseCases, lastPluginSync }));
vi.mock("@/lib/config", () => ({ config: { githubWebUrl: "https://github.example.com" } }));
vi.mock("@/lib/runtime-settings", () => ({
  getPluginsRepoConfig: vi.fn(async () => repoConfig.value),
}));

const syncRoute = await import("@/app/api/plugins/sync/route");
const listRoute = await import("@/app/api/plugins/route");
const detailRoute = await import("@/app/api/plugins/[name]/route");

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
  it("reports whether the sync is configured, without the token, with the last report", async () => {
    const res = await syncRoute.GET();
    expect(await res.json()).toEqual({
      configured: true,
      repo: "opspresso/agent-plugins",
      branch: "main",
      last: null,
    });
    expect(lastPluginSync).toHaveBeenCalledWith("opspresso/agent-plugins");
  });

  it("says unconfigured when the repo or token is missing", async () => {
    repoConfig.value = { repo: undefined, branch: "main", token: "gh-token" };
    const res = await syncRoute.GET();
    expect(await res.json()).toEqual({ configured: false, repo: null, branch: "main", last: null });
  });
});

describe("POST /api/plugins/sync", () => {
  it("forwards the kind-qualified removal selection and the caller's email", async () => {
    const selection = {
      remove: { skills: ["gitops"], mcpServers: ["argocd"], plugins: ["retired"] },
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
    const res = await post({ remove: { skills: "gitops" } });
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

describe("GET /api/plugins/[name]", () => {
  const get = (name: string) =>
    detailRoute.GET(new Request(`https://studio.example.com/api/plugins/${name}`), {
      params: Promise.resolve({ name }),
    });

  it("returns the plugin", async () => {
    const row = {
      name: "devops",
      repo: "opspresso/agent-plugins",
      branch: "main",
      skills: ["gitops"],
      mcpServers: ["argocd"],
    };
    pluginUseCases.get.mockResolvedValue(row);
    const res = await get("devops");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ...row,
      repositoryUrl: "https://github.example.com/opspresso/agent-plugins",
    });
  });

  it("does not expose repository links for an uploaded archive", async () => {
    const row = {
      name: "devops",
      repo: "opspresso/agent-plugins",
      branch: "archive",
      commitSha: "a".repeat(64),
      skills: ["gitops"],
      mcpServers: ["argocd"],
    };
    pluginUseCases.get.mockResolvedValue(row);
    const res = await get("devops");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...row, repositoryUrl: null });
  });

  it("keeps links for a Git branch even when its commit id is 64 hex characters", async () => {
    const row = {
      name: "devops",
      repo: "opspresso/agent-plugins",
      branch: "main",
      commitSha: "a".repeat(64),
      skills: ["gitops"],
      mcpServers: ["argocd"],
    };
    pluginUseCases.get.mockResolvedValue(row);
    const res = await get("devops");
    expect(await res.json()).toEqual({
      ...row,
      repositoryUrl: "https://github.example.com/opspresso/agent-plugins",
    });
  });

  it("accepts a period-bearing name — the spec allows it, the registry slug does not", async () => {
    pluginUseCases.get.mockResolvedValue({ name: "org.example.tools" });
    const res = await get("org.example.tools");
    expect(res.status).toBe(200);
    expect(pluginUseCases.get).toHaveBeenCalledWith("org.example.tools");
  });

  it("400s a name outside the spec's rule without reaching the use case", async () => {
    const res = await get("Not--Valid");
    expect(res.status).toBe(400);
    expect(pluginUseCases.get).not.toHaveBeenCalled();
  });
});
