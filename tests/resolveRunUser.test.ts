import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveRunUser } from "@/application/auth/resolveRunUser";
import { setAdminCheck } from "@/application/agent/agentUseCases";
import type { AgentRepository } from "@/domain/agent/repository";
import type { Agent } from "@/domain/agent/types";
import type { Member } from "@/domain/member/types";
import { memberFixture } from "./memberFixture";

const users = new Map<string, Member>();
let agent: Agent;
const deps = { members: { getById: async (id: string) => users.get(id) ?? null },
  agents: { get: async () => agent } as unknown as AgentRepository };
beforeEach(() => {
  setAdminCheck(async () => false);
  users.clear(); users.set("registrar", memberFixture({ id: "registrar", email: "person@example.test" }));
  agent = { name: "agent", displayName: "Agent", description: "", ownerEmail: "owner@example.test", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
});
afterEach(() => setAdminCheck(async () => false));

describe("current execution user", () => {
  it("resolves the captured ID to the current email rather than the Agent owner", async () => {
    users.get("registrar")!.email = "renamed@example.test";
    expect(await resolveRunUser(deps, "agent", "registrar")).toEqual({ userId: "registrar", email: "renamed@example.test" });
  });
  it("does not adopt a new account with the old email after account deletion", async () => {
    users.delete("registrar"); users.set("replacement", memberFixture({ id: "replacement", email: "person@example.test" }));
    await expect(resolveRunUser(deps, "agent", "registrar")).rejects.toMatchObject({ status: 403 });
    await expect(resolveRunUser(deps, "agent", "")).rejects.toMatchObject({ status: 403 });
  });
  it("refuses a guest even when they own the Agent", async () => {
    users.get("registrar")!.tier = "guest";
    agent.ownerEmail = users.get("registrar")!.email;
    await expect(resolveRunUser(deps, "agent", "registrar")).rejects.toMatchObject({ status: 403 });
  });
  it.each(["member", "admin", "researcher"])("allows the %s tier to run a public Agent", async tier => {
    users.get("registrar")!.tier = tier;
    await expect(resolveRunUser(deps, "agent", "registrar")).resolves.toMatchObject({ userId: "registrar" });
  });
  it("rechecks current private Agent ownership", async () => {
    agent = { ...agent, visibility: "private", ownerEmail: "person@example.test" };
    await expect(resolveRunUser(deps, "agent", "registrar")).resolves.toMatchObject({ userId: "registrar" });
    agent.ownerEmail = "other@example.test";
    await expect(resolveRunUser(deps, "agent", "registrar")).rejects.toMatchObject({ status: 403 });
  });
});
