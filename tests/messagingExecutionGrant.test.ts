import { describe, expect, it, vi } from "vitest";
import type { Agent } from "@/domain/agent/types";
import type { AgentRepository } from "@/domain/agent/repository";
import type { MessagingExecutionGrant } from "@/domain/execution/actor";
import { assertMessagingExecutionGrant } from "@/application/auth/messagingGrant";

const email = "caller@example.test";
const agent: Agent = { name: "demo", displayName: "Demo", description: "", ownerEmail: "owner@example.test",
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  slack: { enabled: true, botToken: "encrypted", signingSecret: "encrypted" },
  telegram: { enabled: true, botToken: "encrypted", webhookSecret: "encrypted" },
  teams: { enabled: true, appId: "fixture", appPassword: "encrypted" } };

describe("verified messaging caller authorization", () => {
  it.each(["slack", "telegram", "teams"] as const)("rechecks the same %s sender's linked Studio account", async kind => {
    const grant: MessagingExecutionGrant = { agentName: "demo", kind, realm: "realm", externalId: "sender", userId: "caller-id", email };
    const resolve = vi.fn(async () => ({ userId: "caller-id", email }));
    const deps = { agents: { get: async () => agent } as unknown as AgentRepository, messagingIdentities: { resolve } };
    await assertMessagingExecutionGrant(deps, grant);
    expect(resolve).toHaveBeenCalledWith({ agentName: "demo", platform: kind, realm: "realm", externalId: "sender" });
    resolve.mockResolvedValue({ userId: "replacement-account", email });
    await expect(assertMessagingExecutionGrant(deps, grant)).rejects.toThrow("no longer authorized");
  });
  it("rejects a disconnected sender or disabled integration without borrowing the Agent owner's identity", async () => {
    const grant: MessagingExecutionGrant = { agentName: "demo", kind: "telegram", realm: "telegram", externalId: "1", userId: "caller-id", email };
    await expect(assertMessagingExecutionGrant({ agents: { get: async () => agent } as unknown as AgentRepository,
      messagingIdentities: { resolve: async () => null } }, grant)).rejects.toThrow("no longer authorized");
    await expect(assertMessagingExecutionGrant({ agents: { get: async () => ({ ...agent, telegram: { ...agent.telegram!, enabled: false } }) } as unknown as AgentRepository,
      messagingIdentities: { resolve: async () => ({ userId: "caller-id", email }) } }, grant)).rejects.toThrow("no longer authorized");
  });
  it("propagates failed identity checks before any effect", async () => {
    const grant: MessagingExecutionGrant = { agentName: "demo", kind: "slack", realm: "team", externalId: "U1", userId: "caller-id", email };
    await expect(assertMessagingExecutionGrant({ agents: { get: async () => agent } as unknown as AgentRepository,
      messagingIdentities: { resolve: async () => { throw new Error("identity store unavailable"); } } }, grant)).rejects.toThrow("identity store unavailable");
  });
});
