import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `PUT /api/settings` validates with its own zod schema before anything reaches
 * `settingsUseCases.update`, so a key missing from that schema is silently
 * stripped even though `SettingsUpdate` is typed over every `SettingKey`. That
 * happened to `toolsRepo`/`toolsRepoBranch`: the view exposed them and
 * `getToolsRepoConfig` read the stored override, but no request could set it.
 * This pins the schema against the keys the runtime actually consumes.
 */
const { useCases } = vi.hoisted(() => ({
  useCases: { update: vi.fn(), getView: vi.fn() },
}));

vi.mock("@/lib/session", () => ({
  withDeploymentAdminAuth:
    (handler: (user: unknown, ...args: any[]) => unknown) =>
    (...args: any[]) =>
      handler({ id: "u1", email: "admin@example.com", name: "A", image: null }, ...args),
}));
vi.mock("@/lib/container", () => ({ settingsUseCases: useCases }));
vi.mock("@/lib/runtime-settings", () => ({ invalidateSettingsCache: vi.fn() }));

const { PUT } = await import("@/app/api/settings/route");

const put = (body: unknown) =>
  PUT(
    new Request("https://studio.example.com/api/settings", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  useCases.update.mockResolvedValue({ fields: {} });
});

describe("PUT /api/settings", () => {
  it("forwards the repo-sync keys, tools included, to settingsUseCases.update", async () => {
    const body = {
      skillsRepo: "org/skills",
      skillsRepoBranch: "main",
      toolsRepo: "org/tools",
      toolsRepoBranch: "release",
    };
    const res = await put(body);
    expect(res.status).toBe(200);
    expect(useCases.update).toHaveBeenCalledWith(body, "admin@example.com");
  });

  it("400s on a malformed body without reaching the use case", async () => {
    const res = await put({ toolsRepo: 42 });
    expect(res.status).toBe(400);
    expect(useCases.update).not.toHaveBeenCalled();
  });
});
