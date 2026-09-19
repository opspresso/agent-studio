import { describe, expect, it } from "vitest";
import { projectHasAudioTools } from "@/domain/project/audioAccess";
import type { AgentConfiguration } from "@/domain/project/types";

const configuration = (enabled: boolean): AgentConfiguration => ({
  projectName: "p", systemPrompt: "", model: "openai/gpt-5-mini", parameters: { piiFiltering: false, audioProcessing: enabled },
  mcpList: [], skillList: [], subagentList: [],
});
describe("audio page availability", () => {
  it("uses the current configuration opt-in", () => {
    expect(projectHasAudioTools({ configuration: configuration(true) })).toBe(true);
    expect(projectHasAudioTools({ configuration: configuration(false) })).toBe(false);
  });
  it("hides audio for an unconfigured project", () => {
    expect(projectHasAudioTools({})).toBe(false);
  });
});
