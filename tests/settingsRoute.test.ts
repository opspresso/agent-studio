import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SecretCipher } from "@/domain/security/secretCipher";

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
const { createSettingsUseCases } = await import("@/application/settings/settingsUseCases");

/**
 * The real use cases, only to enumerate the keys the runtime actually has. The
 * store is empty and no field is a stored secret, so `mask` is the only cipher
 * method `getView` reaches — the rest of the port is stubbed away rather than
 * stood up.
 */
const realUseCases = createSettingsUseCases(
  {
    get: async () => null,
    put: async () => {},
    getTenant: async () => null,
    putTenant: async () => {},
  },
  { mask: (value: string) => value } as unknown as SecretCipher,
  // An empty environment: every key then reports its default or `unset`, which
  // is all this needs — the point is which keys exist, not what they hold.
  {} as NodeJS.ProcessEnv,
  () => [],
);

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

  it("accepts every key the runtime has, so none can be silently stripped", async () => {
    // The general form of the `toolsRepo` bug above, which had already happened
    // a second time to `unknownModelPolicy`: the field specs grow a key, the
    // view reports it, a getter reads the stored override, and the one door it
    // has to come through does not list it. Clearing is valid for every field,
    // so the empty string exercises the whole set at once.
    const keys = Object.keys((await realUseCases.getView()).fields);
    expect(keys.length).toBeGreaterThan(10);
    const body = Object.fromEntries(keys.map((key) => [key, ""]));
    const res = await put(body);
    expect(res.status).toBe(200);
    expect(useCases.update).toHaveBeenCalledWith(body, "admin@example.com");
  });

  it("takes only the two policies the dispatcher acts on", async () => {
    // A free string would store "reufse", which `getUnknownModelPolicy` reads as
    // `allow` — the setting saved, the page showing it, and nothing refused.
    expect((await put({ unknownModelPolicy: "refuse" })).status).toBe(200);
    expect((await put({ unknownModelPolicy: "reufse" })).status).toBe(400);
  });
});
