import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TriggerRun } from "@/domain/trigger/types";

const f = vi.hoisted(() => ({ rows: [] as TriggerRun[] }));
vi.mock("@/lib/session", () => ({ withAuth: (handler: (user: { email: string }, request: Request, context: unknown) => Promise<Response>) =>
  (request: Request, context: unknown) => handler({ email: "owner@example.test" }, request, context) }));
vi.mock("@/lib/container", async () => ({ triggerUseCases:
  (await import("@/application/trigger/triggerUseCases")).createTriggerUseCases({ members: { getById: async () => null },
    agents: { get: async () => ({ name: "agent", ownerEmail: "owner@example.test" }) } as never,
    triggers: { listRuns: async () => f.rows } as never, cipher: {} as never,
  }) }));
import { GET } from "@/app/api/agents/[name]/triggers/[trigger]/runs/route";
beforeEach(() => { f.rows = []; });
describe("Trigger history response", () => {
  it("returns visible history without the durable execution owner's control fields", async () => {
    const visible: TriggerRun = { agentName: "agent", triggerId: "webhook", runId: "run", status: "running", startedAt: "2026-09-29T00:00:00Z" };
    f.rows = [{ ...visible, runningLeaseToken: "private-owner-token", runningLeaseUntil: "2026-09-29T00:11:00Z" }];
    const response = await GET(new Request("https://studio.test/api/agents/agent/triggers/webhook/runs"), {
      params: Promise.resolve({ name: "agent", trigger: "webhook" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ runs: [visible] });
  });
});
