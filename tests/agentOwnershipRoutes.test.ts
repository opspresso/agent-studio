import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeStore } from "./fakeStore";
import { agentRepository } from "@/infrastructure/db/repositories/agentRepository";
import type { Agent } from "@/domain/agent/types";

const identity = vi.hoisted(() => ({ email: "owner@example.test", tier: "member" }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: async () => ({ user: {
  id: "session-user", name: "Test", email: identity.email, tier: identity.tier,
} }) } } }));
vi.mock("@/lib/container", async () => {
  const { agentRepository } = await import("@/infrastructure/db/repositories/agentRepository");
  const { createAgentUseCases } = await import("@/application/agent/agentUseCases");
  const { createConfigurationUseCases } = await import("@/application/agent/configurationUseCases");
  const { secretCipher } = await import("@/infrastructure/crypto/secretCipher");
  return {
    agentUseCases: createAgentUseCases(agentRepository),
    configurationUseCases: createConfigurationUseCases({ agents: agentRepository, cipher: secretCipher,
      refs: { agents: agentRepository, skills: { get: async () => null }, mcps: { get: async () => null } } }),
  };
});
const { GET, PUT, DELETE } = await import("@/app/api/agents/[name]/route");
const { PUT: putConfiguration } = await import("@/app/api/agents/[name]/configuration/route");
const store = await import("@/infrastructure/db/store") as unknown as FakeStore;
const owner = "owner@example.test";
const context = { params: Promise.resolve({ name: "shared" }) };
const at = "2026-10-02T00:00:00.000Z";
const configurationInput = { model: "openai/gpt-5-mini", systemPrompt: "Original", parameters: { piiFiltering: false }, mcpList: [], skillList: [], subagentList: [] };
const agent: Agent = { name: "shared", displayName: "Shared", description: "", visibility: "public", ownerEmail: owner, createdAt: at, updatedAt: at,
  configuration: { ...configurationInput, agentName: "shared" } };
const request = (method: string, body?: unknown) => new Request("https://studio.test/api/agents/shared", {
  method, headers: { origin: "https://studio.test", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(at); store.rows.clear();
  vi.stubEnv("ADMIN_EMAILS", "admin@example.test");
  vi.stubEnv("AES_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  identity.email = owner; identity.tier = "member";
  await agentRepository.create(agent);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("Agent ownership at the HTTP boundary", () => {
  it.each(["member", "admin"])("allows %s use of public Agents but refuses another person's settings and deletion", async tier => {
    identity.email = `${tier}@example.test`; identity.tier = tier;
    expect((await GET(request("GET"), context)).status).toBe(200);
    expect((await PUT(request("PUT", { description: "Changed" }), context)).status).toBe(403);
    expect((await putConfiguration(request("PUT", { ...configurationInput, expectedUpdatedAt: at, systemPrompt: "Changed" }), context)).status).toBe(403);
    expect((await DELETE(request("DELETE"), context)).status).toBe(403);
    expect((await agentRepository.get("shared"))?.configuration?.systemPrompt).toBe("Original");
    expect((await agentRepository.get("shared"))?.description).toBe("");
  });
  it("lets the creator save configuration and metadata through the same owner policy", async () => {
    expect((await putConfiguration(request("PUT", { ...configurationInput, expectedUpdatedAt: at, systemPrompt: "Saved by owner" }), context)).status).toBe(200);
    expect((await PUT(request("PUT", { description: "Owner's update" }), context)).status).toBe(200);
    const saved = await agentRepository.get("shared");
    expect(saved).toMatchObject({ description: "Owner's update", configuration: { systemPrompt: "Saved by owner" } });
  });
  it("keeps a downgraded owner read-only", async () => {
    identity.tier = "guest";
    expect((await GET(request("GET"), context)).status).toBe(200);
    expect((await PUT(request("PUT", { description: "Changed" }), context)).status).toBe(403);
    expect((await DELETE(request("DELETE"), context)).status).toBe(403);
  });
  it("does not let installation administration expose a private Agent", async () => {
    await agentRepository.update({ ...agent, visibility: "private" }, at);
    identity.email = "admin@example.test"; identity.tier = "admin";
    expect((await GET(request("GET"), context)).status).toBe(403);
  });
});
