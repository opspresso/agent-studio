import { beforeEach, describe, expect, it, vi } from "vitest";
import { ValidationError } from "@/application/errors";

const { testModel } = vi.hoisted(() => ({ testModel: vi.fn() }));

vi.mock("@/lib/session", () => ({
  withAdminAuth:
    (handler: (user: unknown, ...args: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      handler({ id: "u1", email: "admin@example.com", name: "A", image: null }, ...args),
}));
vi.mock("@/lib/container", () => ({ testModel }));

const { POST } = await import("@/app/api/models/test/route");

const post = (body: unknown) =>
  POST(
    new Request("https://studio.example.com/api/models/test", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/models/test", () => {
  it("returns the probe result — a failed probe is a 200, not a 5xx", async () => {
    testModel.mockResolvedValue({ ok: false, latencyMs: 42, error: "upstream said 401" });

    const res = await post({ model: "openai/gpt-5.4" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, latencyMs: 42, error: "upstream said 401" });
    expect(testModel).toHaveBeenCalledWith("openai/gpt-5.4");
  });

  it("400s on a malformed body without touching the channel", async () => {
    const res = await post({ model: 42 });
    expect(res.status).toBe(400);
    expect(testModel).not.toHaveBeenCalled();
  });

  it("maps an unknown-model refusal to a 400", async () => {
    testModel.mockRejectedValue(new ValidationError('Unknown model "openai/not-a-model"'));

    const res = await post({ model: "openai/not-a-model" });

    expect(res.status).toBe(400);
  });
});
