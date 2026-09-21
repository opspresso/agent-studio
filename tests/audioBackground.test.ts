import { describe, expect, it, vi } from "vitest";
import { buildAgentDeps } from "@/application/execution/agentBindings";
import type { ExecutionDeps } from "@/application/execution/deps";
import { descend } from "@/domain/execution/actor";
import type { AgentConfiguration } from "@/domain/project/types";
import { FakeChannel } from "./fakeChannel";
import { resolveRunTools } from "@/application/execution/bindings";
import { prepareMemoryForRun } from "@/application/execution/memoryRecall";

describe("background audio recursion guard", () => {
  it("withholds submission tools from the postprocessor and all of its subagents", async () => {
    const audioTools = vi.fn(async () => vi.fn(async () => ({ text: "queued" })));
    const deps = { channel: new FakeChannel([]), audioTools } as unknown as ExecutionDeps;
    const configuration: AgentConfiguration = { projectName: "writer",  model: "openai/gpt-5-mini",
      systemPrompt: "",  parameters: { piiFiltering: false, audioProcessing: true },
      skillList: [], mcpList: [], subagentList: [] };
    const normal = await buildAgentDeps(deps, configuration, "writer", async () => {}, { ancestry: ["writer"] });
    expect(normal.audioTools).toBeDefined();
    const origin = { ancestry: ["writer"], backgroundTask: true };
    const background = await buildAgentDeps(deps, configuration, "writer", async () => {}, origin);
    const child = await buildAgentDeps(deps, configuration, "child", async () => {}, descend(origin, "child"));
    expect(background.audioTools).toBeUndefined(); expect(child.audioTools).toBeUndefined();
    for (const built of [background, child]) {
      expect(built.loadSkillContent).toBeDefined();
      for (const capability of ["callMcpTool", "loadAgent", "saveFile", "fileTool", "generateImage", "editImage", "fetchUrl", "readSlack"] as const) {
        expect(built[capability]).toBeUndefined();
      }
    }
    expect(audioTools).toHaveBeenCalledTimes(1);
  });

  it("does not resolve external bindings or discover capabilities for source postprocessing", async () => {
    const denied = vi.fn(async () => { throw new Error("External capability must not be resolved"); });
    const deps = { mcps: { get: denied }, projects: { get: denied }, externalAgents: { get: denied },
      catalog: { search: denied }, skills: { describe: vi.fn(async () => [{ name: "writer", description: "Writing guidance" }]) } } as unknown as ExecutionDeps;
    const configuration: AgentConfiguration = { projectName: "writer",  model: "openai/gpt-5-mini",
      systemPrompt: "",  parameters: { piiFiltering: false, dynamicCapabilities: true, memoryRecall: true },
      skillList: ["writer"], mcpList: [{ name: "remote" }], subagentList: [{ name: "remote-agent", type: "remote" }] };
    const resolved = await resolveRunTools(deps, configuration, undefined, ["source"], { backgroundTask: true });
    expect(denied).not.toHaveBeenCalled();
    expect(resolved.skills).toHaveLength(1);
    expect(resolved.subagents).toEqual([]);
    expect(resolved.mcp.mcpTools).toEqual([]);
    expect(resolved.configuration.parameters.memoryRecall).toBe(false);
    expect(resolved.configuration.parameters.dynamicCapabilities).toBe(false);
    expect(configuration.mcpList).toEqual([{ name: "remote" }]);
    expect(await prepareMemoryForRun(deps, { configuration, query: "private source", origin: { backgroundTask: true } }))
      .toEqual({ input: {}, warnings: [], asked: 0, failed: 0 });
    expect(denied).not.toHaveBeenCalled();
    await resolved.mcp.close?.();
  });
});
