import { describe, expect, it } from "vitest";
import { agentHasAudioTools } from "@/domain/agent/audioAccess";
import type { AgentConfiguration } from "@/domain/agent/types";

const configuration = (enabled: boolean): AgentConfiguration => ({
  agentName: "p", systemPrompt: "", model: "openai/gpt-5-mini", parameters: { piiFiltering: false, audioProcessing: enabled },
  mcpList: [], skillList: [], subagentList: [],
});
describe("audio page availability", () => {
  it("uses the current configuration opt-in", () => {
    expect(agentHasAudioTools({ configuration: configuration(true) })).toBe(true);
    expect(agentHasAudioTools({ configuration: configuration(false) })).toBe(false);
  });
  it("hides audio for an unconfigured agent", () => {
    expect(agentHasAudioTools({})).toBe(false);
  });
});
