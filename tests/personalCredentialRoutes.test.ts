import { beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => {
  const tokens = () => ({ status: vi.fn(), generate: vi.fn(), reveal: vi.fn(), revoke: vi.fn() });
  return { api: tokens(), webhook: tokens() };
});
vi.mock("@/lib/container", () => ({ apiTokenUseCases: f.api, webhookTokenUseCases: f.webhook }));
vi.mock("@/lib/session", () => {
  const wrap = (handler: (user: { id: string }, request: Request, context: unknown) => unknown) =>
    (request: Request, context: unknown) => handler({ id: "signed-in-user" }, request, context);
  return { withAuth: wrap, withMemberAuth: wrap };
});
const api = await import("@/app/api/agents/[name]/token/route");
const webhook = await import("@/app/api/agents/[name]/webhook-token/route");
const apiReveal = await import("@/app/api/agents/[name]/token/reveal/route");
const webhookReveal = await import("@/app/api/agents/[name]/webhook-token/reveal/route");
const context = { params: Promise.resolve({ name: "agent" }) };
beforeEach(() => {
  vi.clearAllMocks();
  for (const tokens of [f.api, f.webhook]) {
    tokens.status.mockResolvedValue({ configured: false, canIssue: true });
    tokens.generate.mockResolvedValue({ token: "synthetic-token", credentialId: "public-id", masked: "****", createdAt: "2026-10-02T00:00:00Z" });
    tokens.reveal.mockResolvedValue({ token: "synthetic-token", credentialId: "public-id", createdAt: "2026-10-02T00:00:00Z" });
    tokens.revoke.mockResolvedValue(undefined);
  }
});

describe.each([
  ["API", api, apiReveal, f.api, f.webhook],
  ["Webhook", webhook, webhookReveal, f.webhook, f.api],
] as const)("personal %s credential routes", (_label, routes, reveal, tokens, otherPurpose) => {
  it("uses only the session user and the bound purpose for every operation", async () => {
    const body = JSON.stringify({ userId: "agent-owner", email: "owner@example.test", purpose: "other" });
    const request = (method: string) => new Request("https://studio.example.test/credentials", { method, ...(method !== "GET" ? { body } : {}) });
    await routes.GET(request("GET"), context);
    const issued = await routes.POST(request("POST"), context);
    const revealed = await reveal.POST(request("POST"), context);
    const revoked = await routes.DELETE(request("DELETE"), context);
    for (const method of [tokens.status, tokens.generate, tokens.reveal, tokens.revoke]) {
      expect(method).toHaveBeenCalledExactlyOnceWith("agent", "signed-in-user");
    }
    expect(otherPurpose.generate).not.toHaveBeenCalled();
    expect(otherPurpose.reveal).not.toHaveBeenCalled();
    expect(issued.headers.get("cache-control")).toBe("no-store");
    expect(revealed.headers.get("cache-control")).toBe("no-store");
    expect(revoked.status).toBe(204);
  });
});
