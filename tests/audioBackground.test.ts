import { describe, expect, it, vi } from "vitest";
import { buildAgentDeps } from "@/application/execution/subagentRunner";
import type { ExecutionDeps } from "@/application/execution/deps";
import { descend } from "@/domain/execution/actor";
import type { Version } from "@/domain/project/types";
import { FakeChannel } from "./fakeChannel";

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
    expect(audioTools).toHaveBeenCalledTimes(1);
  });
});
