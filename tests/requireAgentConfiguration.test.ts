import { describe, expect, it } from "vitest";
import { requireAgentConfiguration } from "@/application/agent/configurationUseCases";
import type { Agent, AgentConfiguration } from "@/domain/agent/types";

const configuration: AgentConfiguration = {
  agentName: "p", systemPrompt: "", model: "openai/gpt-5-mini", parameters: { piiFiltering: false },
  mcpList: [], skillList: [], subagentList: [],
};

describe("current Agent settings resolution", () => {
  it("uses the settings from the supplied Agent snapshot", () => {
    const agent = { name: "p", configuration } as Agent;
    const resolved = requireAgentConfiguration(agent);
    const updatedAgent = { ...agent, configuration: { ...configuration, systemPrompt: "new" } };
    expect(resolved).toBe(configuration);
    expect(requireAgentConfiguration(updatedAgent).systemPrompt).toBe("new");
    expect(resolved.systemPrompt).toBe("");
  });
  it("refuses an unconfigured Agent explicitly", () => {
    expect(() => requireAgentConfiguration({ name: "p" } as Agent)).toThrow('Agent "p" is not configured');
  });
});
