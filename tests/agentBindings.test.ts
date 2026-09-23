import { createToolSchemaValidator } from "@/infrastructure/llm/toolSchema";
import { describe, expect, it, vi } from "vitest";
import { buildAgentDeps, prepareSubagent, MAX_SUBAGENT_DEPTH } from "@/application/execution/agentBindings";
import type { ExecutionDeps } from "@/application/execution/deps";
import type { Project, AgentConfiguration } from "@/domain/project/types";
import type { RunOrigin } from "@/domain/execution/actor";
import { FakeChannel } from "./fakeChannel";

function fixture(projectOverrides: Partial<Project> = {}, configurationOverrides: Partial<AgentConfiguration> = {}) {
  const now = "2026-09-12T00:00:00Z";
  const project: Project = { name: "child", displayName: "Child", description: "Specialist", ownerEmail: "owner@example.com",  createdAt: now, updatedAt: now, ...projectOverrides };
  const configuration: AgentConfiguration = { projectName: "child",  systemPrompt: "Child instructions",  model: "openai/gpt-5-mini", parameters: { piiFiltering: false }, mcpList: [], skillList: [], subagentList: [],  ...configurationOverrides };
  const parent: AgentConfiguration = { ...configuration, projectName: "parent", subagentList: [{ name: "child" }] };
  project.configuration = configuration;
  if ("configuration" in projectOverrides) project.configuration = projectOverrides.configuration;
  const projects = { get: vi.fn(async () => project) };
  const deps = {
    createToolSchemaValidator,
    channel: new FakeChannel([]), projects,
    skills: { get: async () => null, describe: async () => [], list: async () => [] },
    now: () => new Date(now),
  } as unknown as ExecutionDeps;
  const origin: RunOrigin = { ancestry: ["parent"], actor: { kind: "user", id: "reader@example.com" }, caller: { displayName: "Reader" } };
  const prepare = (overrides: Partial<RunOrigin> = {}) => prepareSubagent(deps, parent, "child", { message: "task", images: [], maxTurns: 7 }, async () => {}, { ...origin, ...overrides });
  return { deps, parent, project, configuration, origin, prepare, projects };
}

describe("Studio prepares native SDK agent bindings", () => {
  it("binds Workspace for the requesting origin but excludes background task effects", async () => {
    const f = fixture();
    const handler = vi.fn(async () => ({ text: "ready" }));
    f.configuration.parameters.workspaceTools = true;
    f.deps.workspaceTool = vi.fn(async () => handler);
    const bound = await buildAgentDeps(f.deps, f.parent, "parent", async () => {}, f.origin);
    expect(bound.workspaceTool).toBe(handler);
    expect(f.deps.workspaceTool).toHaveBeenCalledWith("parent", f.origin);
    const background = await buildAgentDeps(f.deps, f.parent, "parent", async () => {}, { ...f.origin, backgroundTask: true });
    expect(background.workspaceTool).toBeUndefined();
    expect(f.deps.workspaceTool).toHaveBeenCalledTimes(1);
  });
  it("does not bind Workspace unless the executing configuration opted in", async () => {
    const f = fixture();
    f.deps.workspaceTool = vi.fn();
    expect((await buildAgentDeps(f.deps, f.parent, "parent", async () => {}, f.origin)).workspaceTool).toBeUndefined();
    expect(f.deps.workspaceTool).not.toHaveBeenCalled();
  });
  it("loads the current configuration from the Project", async () => {
    const f = fixture();
    const prepared = await f.prepare();
    expect(prepared.input.projectName).toBe("child");
    expect(f.projects.get).toHaveBeenCalledWith("child");
  });

  it("refuses an Agent without current settings", async () => {
    const f = fixture({ configuration: undefined });
    await expect(f.prepare()).rejects.toThrow("no Agent configuration");
  });

  it("refuses an undeclared target before reading its project", async () => {
    const f = fixture();
    await expect(prepareSubagent(f.deps, { ...f.parent, subagentList: [] }, "child", { message: "task", images: [] }, async () => {}, f.origin)).rejects.toThrow("not connected");
    expect(f.projects.get).not.toHaveBeenCalled();
  });

  it("prevents ancestry cycles before opening child resources", async () => {
    const f = fixture();
    await expect(f.prepare({ ancestry: ["parent", "child"] })).rejects.toThrow("cycle");
    expect(f.projects.get).not.toHaveBeenCalled();
  });

  it("bounds nested delegation depth", async () => {
    const f = fixture();
    await expect(f.prepare({ ancestry: Array.from({ length: MAX_SUBAGENT_DEPTH }, (_, index) => `ancestor-${index}`) })).rejects.toThrow("depth limit");
    expect(f.projects.get).not.toHaveBeenCalled();
  });

  it("prepares the Agent's task and its own caller opt-in", async () => {
    const f = fixture({}, { parameters: { piiFiltering: false, callerContext: true } });
    const prepared = await f.prepare();
    expect(prepared.input.messages).toEqual(expect.arrayContaining([
      { role: "user", content: "task" },
    ]));
    expect(prepared.input.caller).toEqual({ displayName: "Reader" });
    expect(prepared.input.systemPrompt).toBe("Child instructions");
    expect(prepared.input.maxTurn).toBe(7);
  });

  it("clamps a specialist's SDK turn limit to its caller's remaining allowance", async () => {
    const f = fixture({ }, { maxTurn: 30 });
    const prepared = await f.prepare();
    expect(prepared).toMatchObject({ input: { maxTurn: 7, canDispatch: false } });
    await prepared.close();
  });

  it("honors cancellation before any binding read", async () => {
    const f = fixture();
    const signal = AbortSignal.abort("stopped");
    await expect(prepareSubagent(f.deps, f.parent, "child", { message: "task", images: [], signal }, async () => {}, f.origin)).rejects.toBe("stopped");
    expect(f.projects.get).not.toHaveBeenCalled();
  });

  it("does not pre-load unused delegated agents", async () => {
    const f = fixture();
    const bound = await buildAgentDeps(f.deps, f.parent, "parent", async () => {}, f.origin);
    expect(bound.loadAgent).toEqual(expect.any(Function));
    expect(f.projects.get).not.toHaveBeenCalled();
  });
});
