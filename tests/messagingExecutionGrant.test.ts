import { describe, expect, it, vi } from "vitest";
import type { Agent } from "@/domain/agent/types";
import type { AgentRepository } from "@/domain/agent/repository";
import { assertMessagingExecutionGrant, messagingExecutionEmail, messagingExecutionGrant } from "@/application/messaging/executionGrant";

const email = "owner@example.com";
const agent: Agent = { name: "demo", displayName: "Demo", description: "", ownerEmail: email,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  slack: { enabled: true, botToken: "encrypted", signingSecret: "encrypted" },
  telegram: { enabled: true, botToken: "encrypted", webhookSecret: "encrypted" },
  teams: { enabled: true, appId: "fixture", appPassword: "encrypted" } };

describe("messaging execution delegation", () => {
  it.each(["slack", "telegram", "teams"] as const)("captures an explicit %s owner grant and refuses another issuer", async kind => {
    expect(messagingExecutionEmail(agent, kind, undefined, email)).toBeUndefined();
    expect(messagingExecutionEmail(agent, kind, true, email)).toBe(email);
    expect(() => messagingExecutionEmail(agent, kind, true, "admin@example.com")).toThrow("Only the owner");
    const granted = { ...agent, [kind]: { ...agent[kind], executionEmail: email } };
    expect(messagingExecutionEmail(granted, kind, undefined, "admin@example.com")).toBe(email);
    expect(messagingExecutionEmail(granted, kind, false, "admin@example.com")).toBeUndefined();
    const actor = { kind, id: "platform-caller" };
    const grant = messagingExecutionGrant(granted, actor)!;
    expect(grant).toEqual({ agentName: agent.name, kind, email });
    let current: Agent = granted;
    const deps = { agents: { get: async () => current } as unknown as AgentRepository, memberTier: async () => "member" as const };
    await assertMessagingExecutionGrant(deps, grant);
    current = { ...granted, [kind]: { ...granted[kind], executionEmail: undefined } };
    await expect(assertMessagingExecutionGrant(deps, grant)).rejects.toThrow("no longer authorized");
  });
  it("refuses inactive members, disabled integrations and changed ownership without a fallback", async () => {
    const granted = { ...agent, telegram: { ...agent.telegram!, executionEmail: email } };
    const grant = messagingExecutionGrant(granted, { kind: "telegram", id: "1" })!;
    for (const current of [{ ...granted, ownerEmail: "other@example.com" }, { ...granted, telegram: { ...granted.telegram, enabled: false } }]) {
      await expect(assertMessagingExecutionGrant({ agents: { get: async () => current } as unknown as AgentRepository,
        memberTier: async () => "member" }, grant)).rejects.toThrow("no longer authorized");
    }
    const get = vi.fn(async () => granted);
    await expect(assertMessagingExecutionGrant({ agents: { get } as unknown as AgentRepository,
      memberTier: async () => "guest" }, grant)).rejects.toThrow("no longer authorized");
    await expect(assertMessagingExecutionGrant({ agents: { get } as unknown as AgentRepository,
      memberTier: async () => { throw new Error("member store down"); } }, grant)).rejects.toThrow("member store down");
  });
});
