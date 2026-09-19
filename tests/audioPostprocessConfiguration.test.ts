import { describe, expect, it, vi } from "vitest";
import { resolveAudioPostprocessor } from "@/application/audio/postprocessConfiguration";
import { listModels } from "@/domain/llm/models";
import type { Project, AgentConfiguration } from "@/domain/project/types";

const owner = "owner@example.test";
const configuration = (): AgentConfiguration => ({ projectName: "writer",
  model: listModels().find(m => m.capabilities.tools && m.capabilities.structuredOutput)!.id,
  parameters: { piiFiltering: false }, systemPrompt: "Summarize", mcpList: [], skillList: [], subagentList: [] });
const project: Project = { name: "writer", displayName: "Writer", description: "", projectType: "agent", ownerEmail: owner,
  createdAt: "2026-01-01", updatedAt: "2026-01-02" };

describe("postprocessing configuration resolution", () => {
  it("pins a deep snapshot of current settings at submission", async () => {
    const current = { ...project, configuration: configuration() };
    const authorize = vi.fn(async () => current);
    const reference = { projectName: project.name };
    const first = await resolveAudioPostprocessor(authorize, reference, owner);
    current.configuration.systemPrompt = "Updated";
    current.configuration.parameters.piiFiltering = true;
    const second = await resolveAudioPostprocessor(authorize, reference, owner);
    expect(first.configuration.systemPrompt).toBe("Summarize");
    expect(first.configuration.parameters.piiFiltering).toBe(false);
    expect(second.configuration.systemPrompt).toBe("Updated");
    expect(authorize).toHaveBeenCalledWith(project.name, owner);
  });
  it("refuses an unconfigured Agent", async () => {
    await expect(resolveAudioPostprocessor(async () => project, { projectName: project.name }, owner))
      .rejects.toThrow('Postprocessing Agent "writer" is not configured');
  });
  it("rejects an unsupported postprocessing model", async () => {
    const current = { ...project, configuration: { ...configuration(), model: listModels().find(m => !m.capabilities.structuredOutput)!.id } };
    await expect(resolveAudioPostprocessor(async () => current, { projectName: project.name }, owner))
      .rejects.toThrow("does not support structured output");
  });
  it("authorizes before reading settings", async () => {
    await expect(resolveAudioPostprocessor(async () => { throw new Error("denied"); }, { projectName: project.name }, owner))
      .rejects.toThrow("denied");
  });
});
