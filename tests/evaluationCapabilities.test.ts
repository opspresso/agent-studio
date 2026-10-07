import { describe, expect, it } from "vitest";
import type { ModelRequest } from "@openai/agents";
import { createEvidenceCollector } from "@/application/evaluation/evidence";
import { createCapabilityEvidence, observeExpectations } from "@/application/evaluation/capabilityEvidence";
import type { AgentConfiguration } from "@/domain/agent/types";

const configuration: AgentConfiguration = { agentName: "demo", model: "test", systemPrompt: "Help", parameters: { piiFiltering: false },
  skillList: [], mcpList: [{ name: "github" }], subagentList: [] };
const request: ModelRequest = { input: "Find AWS EKS documentation", tools: [], handoffs: [], outputType: "text", modelSettings: {}, tracing: false };
const tool = (name: string, properties: Record<string, unknown> = {}): ModelRequest["tools"][number] => ({ type: "function", name, description: "Available capability", parameters: { type: "object", properties, required: [], additionalProperties: false }, strict: false });

describe("authoritative evaluation capabilities", () => {
  it("retains a dynamically offered AWS tool after 110 huge schemas and distinguishes unused from unavailable", () => {
    const collector = createEvidenceCollector(configuration, [{ role: "user", content: "Find AWS EKS documentation" }]);
    const large = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`field${i}`, { type: "string", description: "x".repeat(500) }]));
    const tools = [...Array.from({ length: 110 }, (_, i) => tool(`bound_${i}`, large)), tool("aws___search_documentation")];
    collector.onModelRequest("demo", "test", { ...request, tools }, [{ name: "aws-knowledge", description: "AWS docs", toolNames: ["aws___search_documentation"] }]);
    collector.observe({ done: true });
    const evidence = collector.finish();
    expect(evidence.savedBindings).not.toContain("aws-knowledge");
    expect(evidence.modelRequests.join("")).not.toContain("aws___search_documentation");
    expect(evidence.capabilities.inventoryComplete).toBe(true);
    expect(evidence.capabilities.snapshots[0]?.tools).toHaveLength(111);
    expect(observeExpectations(evidence.capabilities, { skills: [], tools: ["aws-knowledge", "aws___search_documentation", "missing"], outcome: "" })).toEqual([
      { kind: "tool", name: "aws-knowledge", available: "offered", requests: 0 },
      { kind: "tool", name: "aws___search_documentation", available: "offered", requests: 0 },
      { kind: "tool", name: "missing", available: "not-offered", requests: 0 },
    ]);
  });

  it("keeps late calls and Skill requests after verbose traffic is exhausted", () => {
    const collector = createEvidenceCollector(configuration, []);
    collector.onModelRequest("demo", "test", { ...request, tools: [tool("Skill", { skill_name: { type: "string", enum: ["guide"] } }), tool("Search")] });
    for (let i = 0; i < 100; i++) collector.observe({ toolResult: { toolCallId: String(i), name: "Search", content: "large result".repeat(10_000) } });
    collector.observe({ delta: { toolCalls: [{ id: "late", function: { name: "Skill", arguments: '{"skill_name":"guide"}' } }] } });
    collector.observe({ toolResult: { toolCallId: "late", name: "Skill", content: "Error: unavailable" } });
    collector.observe({ toolResult: { toolCallId: "display", name: "Skill", content: "Progress", displayOnly: true } });
    const evidence = collector.finish();
    expect(evidence.toolTraffic.join("")).not.toContain("late");
    expect(evidence.capabilities).toMatchObject({ toolCalls: 1, toolResults: 101 });
    expect(observeExpectations(evidence.capabilities, { skills: ["guide"], tools: [], outcome: "" })).toEqual([
      { kind: "skill", name: "guide", available: "offered", requests: 1 },
    ]);
  });

  it("scopes server aliases to the Agent that received them and excludes withheld tools", () => {
    const collector = createCapabilityEvidence("root");
    collector.observeRequest("root", "test", { ...request, tools: [tool("Search")] }, [{ name: "first", description: "", toolNames: ["Search", "Blocked"] }]);
    collector.observeRequest("child", "test", { ...request, tools: [tool("Search")] }, [{ name: "second", description: "", toolNames: ["Search"] }]);
    collector.observeChunk({ author: "child", delta: { toolCalls: [{ id: "call", function: { name: "Search", arguments: "{}" } }] } });
    expect(observeExpectations(collector.evidence, { skills: [], tools: ["first", "second", "Blocked"], outcome: "" })).toEqual([
      { kind: "tool", name: "first", available: "offered", requests: 0 },
      { kind: "tool", name: "second", available: "offered", requests: 1 },
      { kind: "tool", name: "Blocked", available: "not-offered", requests: 0 },
    ]);
  });

  it("deduplicates repeated inventories and marks lost coverage as unknown", () => {
    const collector = createCapabilityEvidence("root");
    for (let i = 0; i < 100; i++) collector.observeRequest("root", "test", { ...request, tools: [tool("Search")] }, []);
    expect(collector.evidence.snapshots).toHaveLength(1);
    expect(collector.evidence.inventoryComplete).toBe(true);
    for (let i = 0; i < 40; i++) collector.observeRequest(`child${i}`, "test", { ...request, tools: [tool(`Search${i}`)] }, []);
    expect(collector.evidence.snapshots.length).toBeLessThanOrEqual(32);
    expect(observeExpectations(collector.evidence, { skills: [], tools: ["unseen"], outcome: "" })[0]).toMatchObject({ available: "unknown", requests: null });
  });

  it("does not attribute an ambiguous alias to two servers in separate invocations of the same Agent", () => {
    const collector = createCapabilityEvidence("root");
    for (const name of ["first", "second"]) collector.observeRequest("child", "test", { ...request, tools: [tool("Search")] }, [{ name, description: "", toolNames: ["Search"] }]);
    collector.observeChunk({ author: "child", delta: { toolCalls: [{ function: { name: "Search", arguments: "{}" } }] } });
    expect(observeExpectations(collector.evidence, { skills: [], tools: ["first", "second"], outcome: "" }).map(item => item.requests)).toEqual([null, null]);
  });

  it("does not infer unavailable tools when no model request was captured", () => {
    const collector = createCapabilityEvidence("root");
    expect(observeExpectations(collector.evidence, { skills: [], tools: ["Search"], outcome: "" })[0]?.available).toBe("unknown");
  });
});
