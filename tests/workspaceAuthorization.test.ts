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
  enabled: true, executionEmail: email, secret: "encrypted-fixture", allowConcurrent: false,
  createdAt: agent.createdAt, updatedAt: agent.updatedAt };

function fixture() {
  return { members: { getById: vi.fn(async id => memberFixture({ id, email })) }, agents: { get: vi.fn(async () => agent) } as unknown as AgentRepository,
    triggers: { get: vi.fn(async (): Promise<Trigger | null> => ({ ...grant })) },
    memberTier: vi.fn(async () => "member" as const), backendReady: vi.fn(() => true), enabled: vi.fn(async () => true) };
}

describe("Workspace execution authorization", () => {
  it("allows a guest's own interactive work while keeping Agent access checks", async () => {
    const deps = { ...fixture(), memberTier: async () => "guest" as const };
    await expect(authorizeWorkspaceExecution(deps, "demo", email)).resolves.toBeUndefined();
    await expect(authorizeWorkspaceExecution(deps, "demo", email, { kind: "user", id: email })).resolves.toBeUndefined();
    vi.mocked(deps.agents.get).mockResolvedValue({ ...agent, ownerEmail: "other@example.com", visibility: "private" });
    await expect(authorizeWorkspaceExecution(deps, "demo", email)).rejects.toThrow("private");
  });
  it("refuses a removed account and a guest spending under another actor", async () => {
    await expect(authorizeWorkspaceExecution({ ...fixture(), memberTier: async () => null }, "demo", email)).rejects.toThrow("active account");
    for (const actor of [{ kind: "user", id: "other@example.com" }, { kind: "agent-token", id: email }, { kind: "slack", id: "U1" }] as const) {
      await expect(authorizeWorkspaceExecution({ ...fixture(), memberTier: async () => "guest" as const }, "demo", email, actor)).rejects.toThrow("member access");
    }
  });
  it("uses the current owner grant for a Webhook and rechecks it on later calls", async () => {
    const deps = fixture();
    const actor = { kind: "webhook" as const, id: "demo:webhook" };
    await authorizeWorkspaceExecution(deps, "demo", email, actor);
    expect(deps.triggers.get).toHaveBeenCalledWith("demo", "webhook");
    deps.triggers.get.mockResolvedValue({ ...grant, executionEmail: undefined });
    await expect(authorizeWorkspaceExecution(deps, "demo", email, actor)).rejects.toThrow("no longer authorized");
  });
  it.each(["disabled", "changed-owner", "wrong-kind", "wrong-trigger", "missing", "invalid-actor"])("refuses a %s automation grant", async failure => {
    const deps = fixture();
    if (failure === "disabled") deps.triggers.get.mockResolvedValue({ ...grant, enabled: false });
    if (failure === "changed-owner") vi.mocked(deps.agents.get).mockResolvedValue({ ...agent, ownerEmail: "other@example.com", visibility: "public" });
    if (failure === "wrong-trigger") deps.triggers.get.mockResolvedValue({ ...grant, triggerId: "other" });
    if (failure === "missing") deps.triggers.get.mockResolvedValue(null);
    const actor = { kind: failure === "wrong-kind" ? "schedule" as const : "webhook" as const,
      id: failure === "invalid-actor" ? "invalid" : "demo:webhook" };
    await expect(authorizeWorkspaceExecution(deps, "demo", email, actor)).rejects.toThrow("no longer authorized");
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
