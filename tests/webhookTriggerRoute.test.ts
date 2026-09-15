import { beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ admit: vi.fn(), execute: vi.fn(), after: vi.fn(), deps: {} }));
vi.mock("next/server", () => ({ after: f.after }));
vi.mock("@/lib/container", () => ({ triggerRunnerDeps: f.deps }));
vi.mock("@/application/trigger/runTrigger", () => ({ admitDelivery: f.admit, executeDelivery: f.execute }));
const { POST } = await import("@/app/api/webhook/[project]/route");
const context = { params: Promise.resolve({ project: "code-agent" }) };
const request = (headers: Record<string, string>, body = '{ "action": "opened", "title": "박쥐" }\n') =>
  new Request("https://studio.example.test/api/webhook/code-agent", { method: "POST", headers, body });

beforeEach(() => { vi.clearAllMocks(); f.admit.mockResolvedValue({ status: "accepted", runId: "run-1" }); });

describe("project GitHub webhook delivery route", () => {
  it("passes the original body and GitHub authentication without requiring a custom secret header", async () => {
    const body = '{ "action": "opened", "title": "박쥐" }\n';
    const res = await POST(request({ "X-Hub-Signature-256": "sha256=" + "a".repeat(64), "X-GitHub-Delivery": "delivery-1", "X-GitHub-Event": "issues" }, body), context);
    expect(res.status).toBe(202);
    expect(f.admit).toHaveBeenCalledWith(f.deps, "code-agent", { kind: "github", body,
      signature: "sha256=" + "a".repeat(64), deliveryId: "delivery-1", event: "issues" }, null);
    expect(f.after).toHaveBeenCalledOnce();
    await f.after.mock.calls[0]![0]();
    expect(f.execute).toHaveBeenCalledWith(f.deps, { status: "accepted", runId: "run-1" }, JSON.parse(body));
  });
  it("never downgrades a GitHub delivery to plaintext-secret authentication", async () => {
    f.admit.mockResolvedValueOnce({ status: "unauthorized" });
    const res = await POST(request({ "X-GitHub-Event": "issues", "X-Trigger-Secret": "generic-secret" }), context);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("X-Hub-Signature-256");
    expect(f.admit.mock.calls[0]![2]).toMatchObject({ kind: "github", signature: null });
    expect(f.after).not.toHaveBeenCalled();
  });
  it("preserves generic webhook authentication and idempotency", async () => {
    await POST(request({ "X-Trigger-Secret": "generic-secret", "Idempotency-Key": "event-1" }), context);
    expect(f.admit).toHaveBeenCalledWith(f.deps, "code-agent", "generic-secret", "event-1");
  });
  it.each(["ping", "duplicate", "disabled"])("acknowledges %s without starting a model", async status => {
    f.admit.mockResolvedValueOnce({ status });
    const res = await POST(request({}), context);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, status });
    expect(f.after).not.toHaveBeenCalled();
  });
  it("rejects bad metadata and oversized bodies without dispatching", async () => {
    f.admit.mockResolvedValueOnce({ status: "invalid-delivery" });
    expect((await POST(request({}), context)).status).toBe(400);
    f.admit.mockClear();
    expect((await POST(request({}, "a".repeat(1_000_001)), context)).status).toBe(413);
    expect(f.admit).not.toHaveBeenCalled();
    expect(f.after).not.toHaveBeenCalled();
  });
});
