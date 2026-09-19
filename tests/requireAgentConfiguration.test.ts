import { describe, expect, it } from "vitest";
import { requireAgentConfiguration } from "@/application/project/configurationUseCases";
import type { Project, AgentConfiguration } from "@/domain/project/types";

const configuration: AgentConfiguration = {
  projectName: "p", systemPrompt: "", model: "openai/gpt-5-mini", parameters: { piiFiltering: false },
  mcpList: [], skillList: [], subagentList: [],
};

describe("current Agent settings resolution", () => {
  it("uses the settings from the supplied Project snapshot", () => {
    const project = { name: "p", configuration } as Project;
    const resolved = requireAgentConfiguration(project);
    const updatedProject = { ...project, configuration: { ...configuration, systemPrompt: "new" } };
    expect(resolved).toBe(configuration);
    expect(requireAgentConfiguration(updatedProject).systemPrompt).toBe("new");
    expect(resolved.systemPrompt).toBe("");
  });
  it("refuses an unconfigured Agent explicitly", () => {
    expect(() => requireAgentConfiguration({ name: "p" } as Project)).toThrow('Agent "p" is not configured');
  });
});
