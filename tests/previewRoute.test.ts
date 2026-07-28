import { beforeEach, describe, expect, it, vi } from "vitest";

// Route-handler test: `withAuth` is stubbed to inject a controllable user so the
// real owner gate runs. The preview accepts an unsaved version body whose MCP
// bindings can override the headers sent to a registered server, so it must sit
// behind the same gate as saving one.
const { state, projectRepo, calls } = vi.hoisted(() => ({
  state: { email: "owner@example.com" },
  projectRepo: { get: vi.fn() },
  calls: [] as Array<{ versionName: string; variables?: Record<string, string> }>,
}));

vi.mock("@/lib/session", () => ({
  withAuth:
    (handler: (user: unknown, ...args: never[]) => unknown) =>
    (...args: never[]) =>
      handler({ id: "u1", email: state.email, name: "U", image: null }, ...args),
}));

vi.mock("@/lib/container", () => ({ executionDeps: {}, projectRepository: projectRepo }));

vi.mock("@/application/execution/runProject", () => ({
  previewPrompt: async (
    _deps: unknown,
    input: { version: { versionName: string }; variables?: Record<string, string> },
  ) => {
    calls.push({ versionName: input.version.versionName, variables: input.variables });
    return { messages: [{ role: "system", content: "assembled" }], toolNames: [], warnings: [] };
  },
}));

/**
 * Project authorization now consults the effective admin list, because admins
 * may mutate a project they do not own. These cases are about ownership, so
 * they run with no admin configured — which is also the shape a deployment
 * that never set ADMIN_EMAILS has.
 */
vi.mock("@/lib/runtime-settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/runtime-settings")>()),
  isConfiguredAdmin: async () => false,
}));

const { POST } = await import("@/app/api/projects/[name]/preview/route");

const ctx = () => ({ params: Promise.resolve({ name: "proj" }) });
const body = (extra: Record<string, unknown> = {}) =>
  new Request("https://studio.example.com/api/projects/proj/preview", {
    method: "POST",
    body: JSON.stringify({ model: "gpt-test", ...extra }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  state.email = "owner@example.com";
  projectRepo.get.mockResolvedValue({
    name: "proj",
    displayName: "Proj",
    projectType: "agent",
    ownerEmail: "owner@example.com",
  });
});

describe("POST /api/projects/[name]/preview", () => {
  it("assembles the draft in the body, not a saved version", async () => {
    const res = await POST(body({ systemPrompt: "You are helpful.", variables: { a: "b" } }), ctx());

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ messages: [{ role: "system", content: "assembled" }] });
    expect(calls).toEqual([{ versionName: "draft", variables: { a: "b" } }]);
  });

  it("refuses a caller who does not own the project", async () => {
    state.email = "someone@example.com";

    const res = await POST(body(), ctx());

    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("rejects a body that is not a version", async () => {
    const res = await POST(
      new Request("https://studio.example.com/api/projects/proj/preview", {
        method: "POST",
        body: JSON.stringify({ systemPrompt: "no model" }),
      }),
      ctx(),
    );

    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });
});
