import { webhookCredentialFixture } from "./webhookCredentialFixture";
import { memberFixture } from "./memberFixture";
import { describe, expect, it, vi } from "vitest";
import type { Agent } from "@/domain/agent/types";
import type { AgentRepository } from "@/domain/agent/repository";
import type { Trigger, WebhookTrigger } from "@/domain/trigger/types";
import { authorizeWorkspaceExecution } from "@/application/workspace/workspaceAuthorization";

const email = "owner@example.com";
const agent: Agent = { name: "demo", displayName: "Demo", ownerEmail: email, description: "",
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
const grant: WebhookTrigger = { agentName: "demo", triggerId: "webhook", kind: "webhook", description: "",
  enabled: true, allowConcurrent: false,
  createdAt: agent.createdAt, updatedAt: agent.updatedAt };

function fixture() {
  const identity = webhookCredentialFixture("demo", "fixture-token", email);
  return { apiCredentials: { authorize: async () => null }, messagingIdentities: { resolve: async () => null }, identity, webhookCredentials: identity.credentials, members: { getById: vi.fn(async id => memberFixture({ id, email })) }, agents: { get: vi.fn(async () => agent) } as unknown as AgentRepository,
    triggers: { get: vi.fn(async (): Promise<Trigger | null> => ({ ...grant })) },
    memberTier: vi.fn(async () => "member" as const), backendReady: vi.fn(() => true), enabled: vi.fn(async () => true) };
}

describe("Workspace execution authorization", () => {
  it("uses the captured user ID and refuses account replacement at the same email", async () => {
    const deps = fixture();
    const user = { userId: "original-user", email };
    const actor = { kind: "user" as const, id: email };
    await authorizeWorkspaceExecution(deps, "demo", email, actor, undefined, user);
    expect(deps.members.getById).toHaveBeenCalledWith(user.userId);
    deps.members.getById.mockResolvedValueOnce(memberFixture({ id: "replacement-user", email }));
    await expect(authorizeWorkspaceExecution(deps, "demo", email, actor, undefined, user)).rejects.toThrow("no longer active");
  });

  it("refuses a guest's interactive Workspace execution", async () => {
    const deps = { ...fixture(), memberTier: async () => "guest" as const };
    await expect(authorizeWorkspaceExecution(deps, "demo", email)).rejects.toThrow("member access");
    await expect(authorizeWorkspaceExecution(deps, "demo", email, { kind: "user", id: email })).rejects.toThrow("member access");
    expect(deps.enabled).not.toHaveBeenCalled();
  });
  it("refuses a removed account and a guest spending under another actor", async () => {
    await expect(authorizeWorkspaceExecution({ ...fixture(), memberTier: async () => null }, "demo", email)).rejects.toThrow("active account");
    for (const actor of [{ kind: "user", id: "other@example.com" }, { kind: "agent-token", id: email }, { kind: "slack", id: "U1" }] as const) {
      await expect(authorizeWorkspaceExecution({ ...fixture(), memberTier: async () => "guest" as const }, "demo", email, actor)).rejects.toThrow(actor.kind === "user" ? "identity has changed" : "member access");
    }
  });
  it("requires the exact personal API credential before Workspace execution", async () => {
    const deps = fixture();
    const actor = { kind: "agent-token" as const, id: email };
    await expect(authorizeWorkspaceExecution(deps, "demo", email, actor)).rejects.toThrow("authenticated personal API");
    const grant = { kind: "agent-token" as const, agentName: "demo", userId: "api-user", email, credentialId: "api-token" };
    const authorize = vi.fn(async () => ({ userId: grant.userId, email, credentialId: grant.credentialId }));
    const current = { ...deps, apiCredentials: { authorize } };
    await authorizeWorkspaceExecution(current, "demo", email, actor, grant);
    expect(authorize).toHaveBeenCalledWith("demo", "api-token", "api-user");
    await expect(authorizeWorkspaceExecution({ ...current, apiCredentials: { authorize: async () => null } }, "demo", email, actor, grant)).rejects.toThrow("no longer authorized");
    expect(deps.triggers.get).not.toHaveBeenCalled();
  });
  it("rechecks the personal Webhook credential before queued effects", async () => {
    const deps = fixture();
    const actor = { kind: "webhook" as const, id: "demo:webhook" };
    const caller = { kind: "webhook" as const, agentName: "demo", triggerId: "webhook", ...deps.identity.principal };
    await authorizeWorkspaceExecution(deps, "demo", email, actor, caller);
    deps.identity.revoke();
    await expect(authorizeWorkspaceExecution(deps, "demo", email, actor, caller)).rejects.toThrow("no longer authorized");
  });
  it("does not adopt a different Agent owner for a personal Webhook caller", async () => {
    const deps = fixture();
    vi.mocked(deps.agents.get).mockResolvedValue({ ...agent, ownerEmail: "other@example.test" });
    await expect(authorizeWorkspaceExecution(deps, "demo", email, { kind: "webhook", id: "demo:webhook" },
      { kind: "webhook", agentName: "demo", triggerId: "webhook", ...deps.identity.principal })).resolves.toBeUndefined();
  });
  it.each(["disabled", "wrong-trigger", "missing", "wrong-user"])("refuses a %s Webhook grant", async failure => {
    const deps = fixture();
    if (failure === "disabled") deps.triggers.get.mockResolvedValue({ ...grant, enabled: false });
    if (failure === "wrong-trigger") deps.triggers.get.mockResolvedValue({ ...grant, triggerId: "other" });
    if (failure === "missing") deps.triggers.get.mockResolvedValue(null);
    const caller = { kind: "webhook" as const, agentName: "demo", triggerId: "webhook", ...deps.identity.principal,
      ...(failure === "wrong-user" ? { userId: "another-user" } : {}) };
    await expect(authorizeWorkspaceExecution(deps, "demo", email, { kind: "webhook", id: "demo:webhook" }, caller)).rejects.toThrow("no longer authorized");
  });
  it("requires the verified personal credential even when the actor names a Webhook", async () => {
    await expect(authorizeWorkspaceExecution(fixture(), "demo", email, { kind: "webhook", id: "demo:webhook" })).rejects.toThrow("authenticated personal Webhook");
  });
  it("keeps a schedule's registering user for queued Workspace effects", async () => {
    const deps = fixture();
    const actor = { kind: "schedule" as const, id: "demo:daily" };
    deps.triggers.get.mockResolvedValue({ kind: "schedule", agentName: "demo", triggerId: "daily", description: "",
      enabled: true, allowConcurrent: false, createdBy: { userId: "registrar-id", email }, cron: "0 9 * * *", timezone: "UTC",
      createdAt: agent.createdAt, updatedAt: agent.updatedAt });
    await authorizeWorkspaceExecution(deps, "demo", email, actor);
    expect(deps.members.getById).toHaveBeenCalledWith("registrar-id");
    const deleted = { ...deps, members: { getById: async () => null } };
    await expect(authorizeWorkspaceExecution(deleted, "demo", email, actor)).rejects.toThrow("no longer active");
    const reassigned = { ...deps, members: { getById: async () => memberFixture({ id: "different-account", email }) } };
    await expect(authorizeWorkspaceExecution(reassigned, "demo", email, actor)).rejects.toThrow("no longer active");
  });
  it("does not substitute a trigger grant for member access or Agent opt-in", async () => {
    const disabled = fixture(); disabled.enabled.mockResolvedValue(false);
    await expect(authorizeWorkspaceExecution(disabled, "demo", email, { kind: "agent-token", id: email })).rejects.toThrow("disabled");
    expect(disabled.triggers.get).not.toHaveBeenCalled();
    const guest = { ...fixture(), memberTier: async () => "guest" as const };
    await expect(authorizeWorkspaceExecution(guest, "demo", email, { kind: "webhook", id: "demo:webhook" })).rejects.toThrow("member access");
    expect(guest.triggers.get).not.toHaveBeenCalled();
  });
  it("propagates a failed identity lookup instead of granting access", async () => {
    const deps = { ...fixture(), memberTier: async () => { throw new Error("member store unavailable"); } };
    await expect(authorizeWorkspaceExecution(deps, "demo", email)).rejects.toThrow("member store unavailable");
    expect(deps.enabled).not.toHaveBeenCalled();
  });
});
