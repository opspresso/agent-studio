import { describe, expect, it, vi } from "vitest";
import { resolveAudioPostprocessor } from "@/application/audio/postprocessConfiguration";
import { listModels } from "@/domain/llm/models";
import type { Agent, AgentConfiguration } from "@/domain/agent/types";

const owner = "owner@example.test";
const configuration = (): AgentConfiguration => ({ agentName: "writer",
  model: listModels().find(m => m.capabilities.tools && m.capabilities.structuredOutput)!.id,
  parameters: { piiFiltering: false }, systemPrompt: "Summarize", mcpList: [], skillList: [], subagentList: [] });
const agent: Agent = { name: "writer", displayName: "Writer", description: "", ownerEmail: owner,
  createdAt: "2026-01-01", updatedAt: "2026-01-02" };

describe("postprocessing configuration resolution", () => {
  it("pins a deep snapshot of current settings at submission", async () => {
    const current = { ...agent, configuration: configuration() };
    const authorize = vi.fn(async () => current);
    const reference = { agentName: agent.name };
    const first = await resolveAudioPostprocessor(authorize, reference, owner);
    current.configuration.systemPrompt = "Updated";
    current.configuration.parameters.piiFiltering = true;
    const second = await resolveAudioPostprocessor(authorize, reference, owner);
    expect(first.configuration.systemPrompt).toBe("Summarize");
    expect(first.configuration.parameters.piiFiltering).toBe(false);
    expect(second.configuration.systemPrompt).toBe("Updated");
    expect(authorize).toHaveBeenCalledWith(agent.name, owner);
  });
  it("refuses an unconfigured Agent", async () => {
    await expect(resolveAudioPostprocessor(async () => agent, { agentName: agent.name }, owner))
      .rejects.toThrow('Postprocessing Agent "writer" is not configured');
  });
  it("rejects an unsupported postprocessing model", async () => {
    const current = { ...agent, configuration: { ...configuration(), model: listModels().find(m => !m.capabilities.structuredOutput)!.id } };
    await expect(resolveAudioPostprocessor(async () => current, { agentName: agent.name }, owner))
      .rejects.toThrow("does not support structured output");
  });
  it("authorizes before reading settings", async () => {
    await expect(resolveAudioPostprocessor(async () => { throw new Error("denied"); }, { agentName: agent.name }, owner))
      .rejects.toThrow("denied");
  });
});
