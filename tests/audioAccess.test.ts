import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertAudioAccessible } from "@/application/audio/access";
import { assertAgentOwner } from "@/application/agent/agentUseCases";
import { createAudioConfigUseCases } from "@/application/audio/audioConfig";
import { agentRepository as agents } from "@/infrastructure/db/repositories/agentRepository";
import { audioJobConfigRepository as configs } from "@/infrastructure/db/repositories/audioJobConfigRepository";
import type { FakeStore } from "./fakeStore";
const store = await import("@/infrastructure/db/store") as unknown as FakeStore;
const at = "2026-10-02T00:00:00Z";
const owner = "owner@example.test";
const member = "member@example.test";
const deps = { agents, memberTier: vi.fn(async (_email: string): Promise<string | null> => "member") };
const authorize = async (name: string, email: string) => { await assertAudioAccessible(deps, name, email); };
const api = createAudioConfigUseCases({ configs, authorize,
  authorizeWrite: async (name, email) => { await assertAgentOwner(agents, name, email); }, validate: async () => {}, now: () => new Date(at) });
const input = { enabled: true, model: "openai/whisper-1", retention: { unit: "months" as const, value: 3, timezone: "UTC" }, maxActive: 2, maxPerOccurrence: 1 };
beforeEach(async () => {
  store.rows.clear(); deps.memberTier.mockReset().mockResolvedValue("member");
  await agents.create({ name: "shared", displayName: "Shared", description: "", ownerEmail: owner, visibility: "public", createdAt: at, updatedAt: at });
});
describe("shared Audio access", () => {
  it("lets a member use a public Agent while only its creator can change the recipe", async () => {
    await expect(assertAudioAccessible(deps, "shared", member)).resolves.toMatchObject({ ownerEmail: owner });
    await api.save("shared", { userId: "owner", email: owner }, input, 0);
    expect(await api.get("shared", member)).toMatchObject({ enabled: true, revision: 1 });
    await expect(api.save("shared", { userId: "member", email: member }, { ...input, enabled: false }, 1)).rejects.toMatchObject({ status: 403 });
    expect((await configs.get("shared"))?.enabled).toBe(true);
  });
  it.each([null, "guest"])("refuses a caller whose current tier is %s", async tier => {
    deps.memberTier.mockResolvedValue(tier);
    await expect(assertAudioAccessible(deps, "shared", member)).rejects.toMatchObject({ status: 403 });
  });
  it("refuses a member after the Agent becomes private, including an administrator", async () => {
    const current = (await agents.get("shared"))!;
    await agents.update({ ...current, visibility: "private" }, at);
    deps.memberTier.mockResolvedValue("admin");
    await expect(assertAudioAccessible(deps, "shared", member)).rejects.toMatchObject({ status: 403 });
    await expect(assertAudioAccessible(deps, "shared", owner)).resolves.toMatchObject({ name: "shared" });
  });
});
