import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ValidationError } from "@/application/errors";
import { loadSelfHostedModels } from "@/domain/llm/models";

const { listSelfHostedServedModels, getSelfHostedModels } = vi.hoisted(() => ({
  listSelfHostedServedModels: vi.fn(),
  getSelfHostedModels: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  withAdminAuth:
    (handler: (user: unknown, ...args: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      handler({ id: "u1", email: "admin@example.com", name: "A", image: null }, ...args),
}));
vi.mock("@/lib/container", () => ({ listSelfHostedServedModels }));
vi.mock("@/lib/runtime-settings", () => ({ getSelfHostedModels }));

const { GET } = await import("@/app/api/models/selfhosted/route");

const DECLARED = {
  id: "selfhosted/google/gemma-4-e4b",
  provider: "selfhosted",
  family: "google/gemma-4-e4b",
  maker: "google",
  displayName: "Gemma 4 E4B",
  pricing: { inputPer1M: 0, outputPer1M: 0 },
  capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true },
  contextWindow: 131072,
  maxTokens: 8192,
};

beforeEach(() => {
  vi.clearAllMocks();
  getSelfHostedModels.mockResolvedValue([DECLARED]);
});

afterEach(() => {
  loadSelfHostedModels([]);
});

describe("GET /api/models/selfhosted", () => {
  it("answers with the stored declarations, what installed, and what the channel serves", async () => {
    loadSelfHostedModels([DECLARED]);
    listSelfHostedServedModels.mockResolvedValue([
      { name: "google/gemma-4-e4b", contextWindow: 131072, vision: true },
    ]);

    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      served: [{ name: "google/gemma-4-e4b", contextWindow: 131072, vision: true }],
      declarations: [DECLARED],
      installed: ["selfhosted/google/gemma-4-e4b"],
    });
  });

  /**
   * The declarations are the editing basis, so the view must survive the
   * serving stack being down — otherwise a stored declaration is invisible
   * exactly when the admin most needs to see and prune it.
   */
  it("keeps the declarations editable when the channel does not answer", async () => {
    listSelfHostedServedModels.mockRejectedValue(new Error("GET http://x/models → 503"));

    const res = await GET();

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      served: null;
      servedError: string;
      declarations: unknown[];
      installed: string[];
    };
    expect(body.served).toBeNull();
    expect(body.servedError).toContain("503");
    expect(body.declarations).toEqual([DECLARED]);
    // Stored but not installed — exactly the state the section must show.
    expect(body.installed).toEqual([]);
  });

  it("is a 400 when no self-hosted channel is configured", async () => {
    listSelfHostedServedModels.mockRejectedValue(
      new ValidationError("No self-hosted provider channel is configured"),
    );

    const res = await GET();

    expect(res.status).toBe(400);
  });
});
