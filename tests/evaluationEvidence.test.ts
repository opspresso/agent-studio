import { describe, expect, it } from "vitest";
import type { ModelRequest } from "@openai/agents";
import type { AgentConfiguration } from "@/domain/agent/types";
import { createEvidenceCollector } from "@/application/evaluation/evidence";

const configuration: AgentConfiguration = { agentName: "demo", model: "test", systemPrompt: "Help", parameters: { piiFiltering: false },
  skillList: ["guide"], mcpList: [{ name: "docs", headers: { Authorization: "private-credential" } }], subagentList: [] };
const request: ModelRequest = { systemInstructions: "Actual instructions", input: "Task", tools: [], handoffs: [], outputType: "text", modelSettings: {}, tracing: false };

describe("evaluation evidence", () => {
  it("keeps parent output, scoped call/result IDs, warnings and failure outcomes", () => {
    const collector = createEvidenceCollector(configuration, [{ role: "user", content: "Task" }]);
    collector.onModelRequest("demo", "test", request);
    collector.observe({ delta: { content: "Parent answer" } });
    collector.observe({ author: "child", transferId: "transfer", error: "Child failed" });
    collector.observe({ author: "child", transferId: "transfer", delta: { content: "Child answer", toolCalls: [{ id: "same", function: { name: "Search", arguments: "{}" } }] } });
    collector.observe({ author: "child", transferId: "transfer", toolResult: { name: "Search", toolCallId: "same", content: "Found" } });
    collector.observe({ warning: "Partial result" });
    collector.observe({ warning: "Partial result" });
    collector.observe({ done: true });
    const result = collector.finish();
    expect(result.output).toBe("Parent answer");
    expect(result.termination).toBe("completed");
    expect(result.warnings).toEqual(["Partial result"]);
    expect(result.toolTraffic.join("\n")).toContain('"transferId":"transfer"');
    expect(result.toolTraffic.join("\n")).toContain("Child failed");
    expect(JSON.stringify(result)).not.toContain("private-credential");
  });

  it("omits image/file bytes and reasoning, retaining delivery metadata and explicit limitations", () => {
    const collector = createEvidenceCollector(configuration, [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,PRIVATE" } }] }]);
    collector.onModelRequest("demo", "test", { ...request, input: [{ type: "message", role: "user", content: [{ type: "input_image", image: "data:image/png;base64,PRIVATE", detail: "auto" }] }] });
    collector.observe({ delta: { reasoningContent: "Hidden thought" }, image: { mimeType: "image/png", b64: "PRIVATE" } });
    collector.observe({ file: { name: "report.txt", mimeType: "text/plain", b64: "PRIVATE", fileId: "file-1", source: "SaveFile" } });
    const result = collector.finish();
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(JSON.stringify(result)).not.toContain("Hidden thought");
    expect(result.artifacts.join("\n")).toContain("file-1");
    expect(result.limitations).toContain("Image and file bytes are omitted; their visual/content quality is unverified.");
  });

  it("bounds repeated large evidence without displacing the final answer or splitting Unicode", () => {
    const collector = createEvidenceCollector(configuration, [{ role: "user", content: "😀".repeat(20_000) }]);
    for (let i = 0; i < 100; i++) {
      collector.onModelRequest("demo", "test", { ...request, systemInstructions: "😀".repeat(20_000) });
      collector.observe({ toolResult: { name: "Search", toolCallId: `call-${i}`, content: "x".repeat(20_000) } });
      collector.observe({ delta: { content: "😀".repeat(1_000) } });
    }
    const result = collector.finish();
    expect(result.output.length).toBeLessThanOrEqual(12_000);
    expect(result.output.isWellFormed()).toBe(true);
    expect(result.modelRequests.join("").length).toBeLessThanOrEqual(32_000);
    expect(result.toolTraffic.join("").length).toBeLessThanOrEqual(16_000);
    expect(result.limitations.some(value => value.includes("truncated"))).toBe(true);
  });

  it("does not claim prompt or terminal evidence when none was captured", () => {
    const result = createEvidenceCollector(configuration, []).finish();
    expect(result.limitations).toEqual(["No model request was captured.", "The run did not report a terminal outcome."]);
  });
});
