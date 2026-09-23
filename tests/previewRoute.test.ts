import { beforeEach, describe, expect, it, vi } from "vitest";

// Route-handler test: `withMemberAuth` is stubbed to inject a controllable
// user. The preview is tier-gated at `member` rather than owner-gated — the
// route says why saving's owner gate is deliberately not applied — so a
// non-owner assembling someone else's project is the contract, not a leak. That
// the rung refuses a guest is `tests/session.test.ts`'s to fix, not this
// file's; here the wrapper is a stub either way.
const { state, projectRepo, calls } = vi.hoisted(() => ({
  state: { email: "owner@example.com" },
  projectRepo: { get: vi.fn() },
  calls: [] as Array<{
    systemPrompt: string;
    message?: string;
    actor?: { kind: string; id: string };
  }>,
}));

vi.mock("@/lib/session", () => ({
  withMemberAuth:
    (handler: (user: unknown, ...args: never[]) => unknown) =>
    (...args: never[]) =>
      handler({ id: "u1", email: state.email, name: "U", image: null }, ...args),
}));

vi.mock("@/lib/container", async () => ({
  executionDeps: {},
  projectUseCases: (
    await import("@/application/project/projectUseCases")
  ).createProjectUseCases(projectRepo as never),
  // Draft mask resolution uses this bound configuration use case.
  configurationUseCases: (
    await import("@/application/project/configurationUseCases")
  ).createConfigurationUseCases({
    projects: projectRepo as never,
    refs: {} as never,
    cipher: {} as never,
  }),
}));

vi.mock("@/application/execution/runProject", () => ({
  previewPrompt: async (
    _deps: unknown,
    input: {
      configuration: { systemPrompt: string };
        message?: string;
      actor?: { kind: string; id: string };
    },
  ) => {
    calls.push({
      systemPrompt: input.configuration.systemPrompt,
      ...(input.message ? { message: input.message } : {}),
      ...(input.actor ? { actor: input.actor } : {}),
    });
    return {
      messages: [{ role: "system", content: "assembled" }],
      toolNames: [],
      tools: [],
      warnings: [],
    };
  },
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
    ownerEmail: "owner@example.com",
  });
});

describe("POST /api/projects/[name]/preview", () => {
  it("assembles the request draft", async () => {
    const res = await POST(body({ systemPrompt: "You are helpful." }), ctx());

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ messages: [{ role: "system", content: "assembled" }] });
    expect(calls).toEqual([{
      systemPrompt: "You are helpful.",
      actor: { kind: "user", id: "owner@example.com" },
    }]);
  });

  it("assembles for a session caller who does not own the project, like a run", async () => {
    state.email = "someone@example.com";

    const res = await POST(body(), ctx());

    expect(res.status).toBe(200);
    expect(calls).toEqual([{
      systemPrompt: "",
      actor: { kind: "user", id: "someone@example.com" },
    }]);
  });

  it("passes the request and signed-in identity to memory-aware preview", async () => {
    const res = await POST(body({ message: "유정열을 검색해서 정리해" }), ctx());

    expect(res.status).toBe(200);
    expect(calls[0]).toMatchObject({
      message: "유정열을 검색해서 정리해",
      actor: { kind: "user", id: "owner@example.com" },
    });
  });

  it("404s on a project that does not exist", async () => {
    projectRepo.get.mockResolvedValue(null);

    const res = await POST(body(), ctx());

    expect(res.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("rejects an invalid configuration body", async () => {
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
