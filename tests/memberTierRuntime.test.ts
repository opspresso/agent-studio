import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMBER_TIERS, type MemberTierDefinition } from "@/domain/member/tiers";
import { settingsRepository } from "@/infrastructure/db/repositories/settingsRepository";
import { getMemberTierLimits, invalidateSettingsCache } from "@/lib/runtime-settings";
import { getMemberTier, invalidateMemberTierCache } from "@/lib/memberAccess";
import { getSessionUser, withMemberAuth } from "@/lib/session";
import { openRun, openTaskRun } from "@/application/run/runBracket";
import type { UsageRepository } from "@/domain/usage/repository";
import type { Agent, AgentConfiguration } from "@/domain/agent/types";

const f = vi.hoisted(() => ({ session: vi.fn(), member: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: f.session } } }));
vi.mock("@/infrastructure/db/repositories/memberRepository", () => ({ memberRepository: { getByEmail: f.member } }));
vi.mock("node:crypto", async original => ({ ...await original<typeof import("node:crypto")>(), randomUUID: () => "00000000-0000-4000-8000-000000000001" }));

const actor = { kind: "user" as const, id: "user@example.test" };
const agent: Agent = { name: "demo", ownerEmail: actor.id, displayName: "Demo", description: "", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" };
const configuration: AgentConfiguration = { agentName: agent.name, model: "openai/gpt-5-mini", systemPrompt: "", parameters: { piiFiltering: false }, mcpList: [], skillList: [], subagentList: [] };
const usage: UsageRepository = {
  record: async () => {}, getDay: async () => null, claimAlert: async () => false, claimMonthAlert: async () => false,
  listByAgent: async () => [], listByDateRange: async () => [], listActorsByAgent: async () => [],
  listMemberDays: async () => [{ email: actor.id, date: "2026-10-01", agentName: agent.name, calls: {}, inputTokens: {}, outputTokens: {}, costUsd: { m: 3 } }],
};
async function catalog(tiers: MemberTierDefinition[]) {
  await settingsRepository.update(() => ({ memberTiers: { revision: 1, tiers }, updatedAt: new Date().toISOString() }));
  invalidateSettingsCache();
}
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime("2026-10-01T00:00:00Z");
  vi.stubEnv("ADMIN_EMAILS", "admin@example.test"); vi.clearAllMocks();
  invalidateMemberTierCache(); invalidateSettingsCache();
  await catalog([...DEFAULT_MEMBER_TIERS, { id: "premium", monthlyCostCapUsd: 10 }]);
  f.member.mockResolvedValue({ tier: "premium" });
  f.session.mockResolvedValue({ user: { id: "u1", email: actor.id, name: "User", tier: "premium" } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); invalidateMemberTierCache(); invalidateSettingsCache(); });

describe("runtime member tier settings", () => {
  it("uses custom tiers for sessions and member APIs and demotes unknown stored IDs to guest", async () => {
    expect((await getSessionUser())?.tier).toBe("premium");
    expect((await withMemberAuth(async () => Response.json({ ok: true }))()).status).toBe(200);
    expect(await getMemberTier(actor.id)).toBe("premium");
    await catalog(DEFAULT_MEMBER_TIERS);
    expect(await getMemberTier(actor.id)).toBe("guest");
    expect((await getSessionUser())?.tier).toBe("guest");
    expect((await withMemberAuth(async () => Response.json({ ok: true }))()).status).toBe(403);
  });
  it("uses changed limits on the next Chat or Workspace run and never caps admin", async () => {
    const deps = { usage, resolveActorLimits: async () => getMemberTierLimits((await getMemberTier(actor.id))!) };
    const chat = await openRun(deps, agent, configuration, actor); await chat.close();
    const task = await openTaskRun(deps, agent, actor); await task.close();
    await catalog([...DEFAULT_MEMBER_TIERS, { id: "premium", monthlyCostCapUsd: 3 }]);
    await expect(openRun(deps, agent, configuration, actor)).rejects.toMatchObject({ status: 429, limitUsd: 3 });
    await expect(openTaskRun(deps, agent, actor)).rejects.toMatchObject({ status: 429, limitUsd: 3 });
    f.member.mockResolvedValue({ tier: "admin" }); invalidateMemberTierCache(actor.id);
    const admin = await openTaskRun(deps, agent, actor); await admin.close();
    expect(await getMemberTierLimits("admin")).toEqual({});
  });
});
