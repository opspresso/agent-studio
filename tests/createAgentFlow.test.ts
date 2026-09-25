import { describe, expect, it, vi } from "vitest";
import { composeCreateAgent } from "@/application/agent/createAgentFlow";
import type { CreateAgentInput } from "@/application/agent/agentUseCases";
import { ConflictError } from "@/application/errors";
import { getModelConfig } from "@/domain/llm/models";
import type { AgentRepository } from "@/domain/agent/repository";
import type { Agent } from "@/domain/agent/types";

const INPUT: CreateAgentInput = { name: "my-bot", displayName: "My Bot", description: "", ownerEmail: "owner@example.com" };
function fixture(models = ["openai/gpt-5-mini"]) {
  const rows = new Map<string, Agent>();
  const agents = { get: async (name: string) => rows.get(name) ?? null,
    create: vi.fn(async (agent: Agent) => { rows.set(agent.name, agent); }) } as unknown as AgentRepository;
  const offered = vi.fn(async () => models.map(id => getModelConfig(id)!));
  return { rows, agents, offered, create: composeCreateAgent({ agents, offered }) };
}

describe("createAgent", () => {
  it("writes the Agent and initial current settings atomically on the first suitable model", async () => {
    const f = fixture(["openrouter/text-embedding-3-small", "openai/gpt-image-2", "openai/gpt-5-mini"]);
    const agent = await f.create(INPUT);
    expect(agent.configuration).toEqual({ agentName: INPUT.name, model: "openai/gpt-5-mini", systemPrompt: "",
      parameters: { piiFiltering: false }, skillList: [], mcpList: [], subagentList: [] });
    expect(f.agents.create).toHaveBeenCalledTimes(1);
    expect(f.rows.get(INPUT.name)).toEqual(agent);
  });
  it("creates an unconfigured Agent when the deployment offers no suitable model", async () => {
    const f = fixture(["openai/gpt-image-2"]);
    expect((await f.create(INPUT)).configuration).toBeUndefined();
    expect(f.rows.size).toBe(1);
  });
  it("does not leave a partial Agent when the atomic creation fails", async () => {
    const f = fixture();
    f.agents.create = async () => { throw new Error("storage unavailable"); };
    await expect(f.create(INPUT)).rejects.toThrow("storage unavailable");
    expect(f.rows.size).toBe(0);
  });
  it("preserves a conflicting Agent without changing its settings", async () => {
    const f = fixture();
    const first = await f.create(INPUT);
    await expect(f.create(INPUT)).rejects.toBeInstanceOf(ConflictError);
    expect(f.rows.get(INPUT.name)).toEqual(first);
    expect(f.agents.create).toHaveBeenCalledTimes(1);
  });
});
