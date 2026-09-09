import { describe, expect, it, vi } from "vitest";
import { buildAgentDeps } from "@/application/execution/subagentRunner";
import type { ExecutionDeps } from "@/application/execution/deps";
import { descend } from "@/domain/execution/actor";
import type { Version } from "@/domain/project/types";
import { FakeChannel } from "./fakeChannel";
import { resolveRunTools } from "@/application/execution/bindings";
import { prepareMemoryForRun } from "@/application/execution/memoryRecall";

describe("background audio recursion guard", () => {
  it("withholds submission tools from the postprocessor and all of its subagents", async () => {
    const audioTools = vi.fn(async () => vi.fn(async () => ({ text: "queued" })));
    const deps = { channel: new FakeChannel([]), audioTools } as unknown as ExecutionDeps;
    const version: Version = { projectName: "writer", versionName: "1", model: "openai/gpt-5-mini",
      systemPrompt: "", userPromptTemplate: "", parameters: { piiFiltering: false, audioProcessing: true },
      skillList: [], mcpList: [], subagentList: [], createdAt: "2026-09-09T00:00:00Z" };
    const normal = await buildAgentDeps(deps, version, "writer", async () => {}, { ancestry: ["writer"] });
    expect(normal.audioTools).toBeDefined();
    const origin = { ancestry: ["writer"], backgroundTask: true };
    const background = await buildAgentDeps(deps, version, "writer", async () => {}, origin);
    const child = await buildAgentDeps(deps, version, "child", async () => {}, descend(origin, "child"));
    expect(background.audioTools).toBeUndefined(); expect(child.audioTools).toBeUndefined();
    for (const built of [background, child]) {
      expect(built.loadSkillContent).toBeDefined();
      for (const capability of ["callMcpTool", "runSubagent", "saveFile", "fileTool", "generateImage", "editImage", "fetchUrl", "readSlack"] as const) {
        expect(built[capability]).toBeUndefined();
      }
    }
    expect(audioTools).toHaveBeenCalledTimes(1);
  });

  it("does not resolve external bindings or discover capabilities for source postprocessing", async () => {
    const denied = vi.fn(async () => { throw new Error("External capability must not be resolved"); });
    const deps = { mcps: { get: denied }, projects: { get: denied }, externalAgents: { get: denied },
      catalog: { search: denied }, skills: { describe: vi.fn(async () => [{ name: "writer", description: "Writing guidance" }]) } } as unknown as ExecutionDeps;
    const version: Version = { projectName: "writer", versionName: "1", model: "openai/gpt-5-mini",
      systemPrompt: "", userPromptTemplate: "", parameters: { piiFiltering: false, dynamicCapabilities: true, memoryRecall: true },
      skillList: ["writer"], mcpList: [{ name: "remote" }], subagentList: [{ name: "remote-agent", type: "remote" }], createdAt: "2026-09-09T00:00:00Z" };
    const resolved = await resolveRunTools(deps, version, undefined, ["source"], { backgroundTask: true });
    expect(denied).not.toHaveBeenCalled();
    expect(resolved.skills).toHaveLength(1);
    expect(resolved.subagents).toEqual([]);
    expect(resolved.mcp.mcpTools).toEqual([]);
    expect(resolved.version.parameters.memoryRecall).toBe(false);
    expect(resolved.version.parameters.dynamicCapabilities).toBe(false);
    expect(version.mcpList).toEqual([{ name: "remote" }]);
    expect(await prepareMemoryForRun(deps, { version, query: "private source", origin: { backgroundTask: true } }))
      .toEqual({ input: {}, warnings: [], asked: 0, failed: 0 });
    expect(denied).not.toHaveBeenCalled();
    await resolved.mcp.close?.();
  });
});
