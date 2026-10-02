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
    expect(await resolveRunUser(deps, "agent", "registrar", "schedule")).toEqual({ userId: "registrar", email: "renamed@example.test" });
  });
  it("does not adopt a new account with the old email after account deletion", async () => {
    users.delete("registrar"); users.set("replacement", memberFixture({ id: "replacement", email: "person@example.test" }));
    await expect(resolveRunUser(deps, "agent", "registrar", "schedule")).rejects.toMatchObject({ status: 403 });
    await expect(resolveRunUser(deps, "agent", "", "schedule")).rejects.toMatchObject({ status: 403 });
  });
  it("permits interactive guest work but refuses automated execution", async () => {
    users.get("registrar")!.tier = "guest";
    expect(await resolveRunUser(deps, "agent", "registrar", "user")).toMatchObject({ userId: "registrar" });
    for (const kind of ["schedule", "webhook", "agent-token", "slack", "telegram", "teams"] as const) {
      await expect(resolveRunUser(deps, "agent", "registrar", kind)).rejects.toMatchObject({ status: 403 });
    }
  });
  it("rechecks current private Agent ownership", async () => {
    agent = { ...agent, visibility: "private", ownerEmail: "person@example.test" };
    await expect(resolveRunUser(deps, "agent", "registrar", "schedule")).resolves.toMatchObject({ userId: "registrar" });
    agent.ownerEmail = "other@example.test";
    await expect(resolveRunUser(deps, "agent", "registrar", "schedule")).rejects.toMatchObject({ status: 403 });
  });
});
