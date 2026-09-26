import { createToolSchemaValidator } from "@/infrastructure/llm/toolSchema";
import { describe, expect, it, vi } from "vitest";
import { buildAgentDeps, prepareSubagent, MAX_SUBAGENT_DEPTH } from "@/application/execution/agentBindings";
import type { ExecutionDeps } from "@/application/execution/deps";
import type { Agent, AgentConfiguration } from "@/domain/agent/types";
import type { RunOrigin } from "@/domain/execution/actor";
import { FakeChannel } from "./fakeChannel";
import { DEFAULT_CALL_ROUTING_POLICY } from "@/domain/llm/callRouting";
import type { RuntimeTurnPersistence } from "@/application/runtime/types";
import { modelRoutingPolicyFingerprint } from "@/application/runtime/session";

function fixture(agentOverrides: Partial<Agent> = {}, configurationOverrides: Partial<AgentConfiguration> = {}) {
  const now = "2026-09-12T00:00:00Z";
  const agent: Agent = { name: "child", displayName: "Child", description: "Specialist", ownerEmail: "owner@example.com",  createdAt: now, updatedAt: now, ...agentOverrides };
  const configuration: AgentConfiguration = { agentName: "child",  systemPrompt: "Child instructions",  model: "openai/gpt-5-mini", parameters: { piiFiltering: false }, mcpList: [], skillList: [], subagentList: [],  ...configurationOverrides };
  const parent: AgentConfiguration = { ...configuration, agentName: "parent", subagentList: [{ name: "child" }] };
  agent.configuration = configuration;
  if ("configuration" in agentOverrides) agent.configuration = agentOverrides.configuration;
  const agents = { get: vi.fn(async () => agent) };
  const deps = {
    createToolSchemaValidator,
    channel: new FakeChannel([]), agents,
    skills: { get: async () => null, describe: async () => [], list: async () => [] },
    now: () => new Date(now),
  } as unknown as ExecutionDeps;
  const origin: RunOrigin = { ancestry: ["parent"], actor: { kind: "user", id: "reader@example.com" }, caller: { displayName: "Reader" } };
  const prepare = (overrides: Partial<RunOrigin> = {}) => prepareSubagent(deps, parent, "child", { message: "task", images: [], maxTurns: 7 }, async () => {}, { ...origin, ...overrides });
  return { deps, parent, agent, configuration, origin, prepare, agents };
}

describe("Studio prepares native SDK agent bindings", () => {
  it.each([true, false])("binds shared policy and checks pending policy identity when opted-in=%s", async (enabled) => {
    const f = fixture({}, { parameters: { piiFiltering: false, modelRouting: enabled } });
    const policy = { ...DEFAULT_CALL_ROUTING_POLICY, tiers: { fast: "local/fast" } };
    f.deps.getCallRoutingPolicy = vi.fn(async () => policy);
    f.deps.callRouting = { decision: { choose: vi.fn() }, selectedDecisionModel: async () => undefined, canUseModel: async () => true };
    const checkBinding = vi.fn();
    const bound = await buildAgentDeps(f.deps, f.configuration, "child", async () => {}, { ...f.origin, backgroundTask: true }, undefined, undefined,
      { checkBinding } as unknown as RuntimeTurnPersistence);
    expect(bound.modelRoutingPolicy).toEqual(policy);
    expect(bound.callRouting).toBe(f.deps.callRouting);
    expect(checkBinding).toHaveBeenCalledWith("model-routing", modelRoutingPolicyFingerprint(policy));
  });
  it("does not bind routing or block unrelated approvals when an Agent never opted in", async () => {
    const f = fixture();
    f.deps.getCallRoutingPolicy = vi.fn();
    const checkBinding = vi.fn();
    const bound = await buildAgentDeps(f.deps, f.configuration, "child", async () => {}, { ...f.origin, backgroundTask: true }, undefined, undefined,
      { checkBinding } as unknown as RuntimeTurnPersistence);
    expect(bound.callRouting).toBeUndefined();
    expect(bound.modelRoutingPolicy).toBeUndefined();
    expect(f.deps.getCallRoutingPolicy).not.toHaveBeenCalled();
    expect(checkBinding).not.toHaveBeenCalled();
  });
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
  it("loads the current configuration from the Agent", async () => {
    const f = fixture();
    const prepared = await f.prepare();
    expect(prepared.input.agentName).toBe("child");
    expect(f.agents.get).toHaveBeenCalledWith("child");
  });

  it("refuses an Agent without current settings", async () => {
    const f = fixture({ configuration: undefined });
    await expect(f.prepare()).rejects.toThrow("no Agent configuration");
  });

  it("refuses an undeclared target before reading its agent", async () => {
    const f = fixture();
    await expect(prepareSubagent(f.deps, { ...f.parent, subagentList: [] }, "child", { message: "task", images: [] }, async () => {}, f.origin)).rejects.toThrow("not connected");
    expect(f.agents.get).not.toHaveBeenCalled();
  });

  it("prevents ancestry cycles before opening child resources", async () => {
    const f = fixture();
    await expect(f.prepare({ ancestry: ["parent", "child"] })).rejects.toThrow("cycle");
    expect(f.agents.get).not.toHaveBeenCalled();
  });

  it("bounds nested delegation depth", async () => {
    const f = fixture();
    await expect(f.prepare({ ancestry: Array.from({ length: MAX_SUBAGENT_DEPTH }, (_, index) => `ancestor-${index}`) })).rejects.toThrow("depth limit");
    expect(f.agents.get).not.toHaveBeenCalled();
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
    expect(f.agents.get).not.toHaveBeenCalled();
  });

  it("does not pre-load unused delegated agents", async () => {
    const f = fixture();
    const bound = await buildAgentDeps(f.deps, f.parent, "parent", async () => {}, f.origin);
    expect(bound.loadAgent).toEqual(expect.any(Function));
    expect(f.agents.get).not.toHaveBeenCalled();
  });
});
