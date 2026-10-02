import { describe, expect, it, vi } from "vitest";
import type { AgentRepository } from "@/domain/agent/repository";
import type { ScheduleTrigger } from "@/domain/trigger/types";
import { assertRunIdentity, authorizeRunIdentity } from "@/application/auth/authorizeRunIdentity";
import { interactiveIdentity } from "./runIdentity";
import { memberFixture } from "./memberFixture";

function fixture() {
  const identity = interactiveIdentity();
  const schedule: ScheduleTrigger = { agentName: "source", triggerId: "daily", kind: "schedule", enabled: true,
    createdBy: identity.user, updatedAt: "revision-1", createdAt: "created", description: "", allowConcurrent: false, cron: "0 9 * * *", timezone: "UTC" };
  const deps = {
    members: { getById: vi.fn(async (id: string) => memberFixture({ id, email: identity.user.email })) },
    agents: { get: vi.fn(async (name: string) => ({ name, ownerEmail: identity.user.email, visibility: "public" })) } as unknown as AgentRepository,
    triggers: { get: vi.fn(async () => schedule) },
    messagingIdentities: { resolve: vi.fn(async () => identity.user) },
    apiCredentials: { authorize: vi.fn(async () => ({ ...identity.user, credentialId: "personal-token" })) },
    webhookCredentials: { authorize: vi.fn(async () => null) },
  };
  return { identity, schedule, deps };
}

describe("current Studio execution authorization", () => {
  it("requires an explicit user and source, even for public Agents", () => {
    const { identity } = fixture();
    expect(() => assertRunIdentity({ ...identity, user: { ...identity.user, userId: "" } })).toThrow("authenticated Studio caller");
    expect(() => assertRunIdentity({ ...identity, actor: { kind: "user", id: "another@example.test" } })).toThrow("does not match");
    expect(() => assertRunIdentity({ ...identity, actor: { kind: "webhook", id: "source:webhook" } })).toThrow("permission grant");
  });

  it("never adopts an account by its email", async () => {
    const { deps, identity } = fixture();
    await authorizeRunIdentity(deps, "target", identity);
    expect(deps.members.getById).toHaveBeenCalledWith(identity.user.userId);
    deps.members.getById.mockResolvedValueOnce(memberFixture({ id: "replacement", email: identity.user.email }));
    await expect(authorizeRunIdentity(deps, "target", identity)).rejects.toThrow("no longer active");
  });

  it("revokes an interactive run when the caller is downgraded to guest", async () => {
    const { deps, identity } = fixture();
    await authorizeRunIdentity(deps, "target", identity);
    deps.members.getById.mockResolvedValueOnce(memberFixture({ id: identity.user.userId, email: identity.user.email, tier: "guest" }));
    await expect(authorizeRunIdentity(deps, "target", identity)).rejects.toThrow("member access");
  });

  it("rechecks the exact personal token after a transfer", async () => {
    const { deps, identity } = fixture();
    const caller = { ...identity, actor: { kind: "agent-token" as const, id: identity.user.email },
      executionGrant: { ...identity.user, kind: "agent-token" as const, agentName: "source", credentialId: "personal-token" } };
    await authorizeRunIdentity(deps, "target", caller);
    expect(deps.apiCredentials.authorize).toHaveBeenCalledWith("source", "personal-token", identity.user.userId);
    deps.apiCredentials.authorize.mockResolvedValueOnce({ ...identity.user, credentialId: "different-token" });
    await expect(authorizeRunIdentity(deps, "target", caller)).rejects.toThrow();
  });

  it("refuses changed or disabled schedules and mismatched source actors", async () => {
    const { deps, identity, schedule } = fixture();
    const caller = { ...identity, actor: { kind: "schedule" as const, id: "source:daily" },
      executionGrant: { ...identity.user, kind: "schedule" as const, agentName: "source", triggerId: "daily", revision: schedule.updatedAt } };
    await authorizeRunIdentity(deps, "target", caller);
    await expect(authorizeRunIdentity(deps, "target", { ...caller, actor: { ...caller.actor, id: "other:daily" } })).rejects.toThrow("Execution source");
    schedule.updatedAt = "revision-2";
    await expect(authorizeRunIdentity(deps, "target", caller)).rejects.toThrow("permission changed");
    schedule.updatedAt = caller.executionGrant.revision;
    schedule.enabled = false;
    await expect(authorizeRunIdentity(deps, "target", caller)).rejects.toThrow("permission changed");
  });
});
