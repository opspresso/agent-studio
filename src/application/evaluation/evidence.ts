import type { ModelRequest } from "@openai/agents";
import type { AgentConfiguration } from "@/domain/agent/types";
import { collectedWarning, isTopLevelChunk, runTermination, type ChatMessageInput, type EngineChunk, type RunTerminationReason } from "@/domain/llm/types";
import { cutCodePoints } from "@/shared/utf8Text";
import type { McpServerInfo } from "@/application/llm/agentAssembly";
import { createCapabilityEvidence, type CapabilityEvidence } from "./capabilityEvidence";

export interface RunEvidence {
  request: string;
  savedBindings: string;
  capabilities: CapabilityEvidence;
  modelRequests: string[];
  toolTraffic: string[];
  output: string;
  artifacts: string[];
  warnings: string[];
  limitations: string[];
  termination?: RunTerminationReason;
  traceId?: string;
}

/** Separate budgets keep a long prompt/tool result from displacing the answer. */
export function createEvidenceCollector(configuration: AgentConfiguration, messages: ChatMessageInput[]) {
  const limitations = new Set<string>();
  const capabilities = createCapabilityEvidence(configuration.agentName);
  if (configuration.parameters.piiFiltering) {
    limitations.add("PII is masked in model requests and again for evaluation; masked identities cannot be compared literally across these records.");
  }
  function budget(max: number, label: string) {
    let left = max;
    return (text: string) => {
      const kept = cutCodePoints(text, left);
      left -= kept.length;
      if (kept.length < text.length) limitations.add(`${label} was truncated.`);
      return kept;
    };
  }
  function json(value: unknown): string {
    let nodes = 0;
    return JSON.stringify(value, (_key, item: unknown) => {
      if (++nodes > 2_000) { limitations.add("Large structured evidence was truncated."); return undefined; }
      if (item && typeof item === "object" && "type" in item) {
        if (["input_image", "image", "image_url", "input_file"].includes(String(item.type))) {
          limitations.add("Image and file bytes are omitted; their visual/content quality is unverified.");
          return { type: item.type, omitted: true };
        }
        if (item.type === "reasoning") return undefined;
      }
      if (typeof item === "string" && item.length > 12_000) {
        limitations.add("A large evidence field was truncated.");
        return cutCodePoints(item, 12_000);
      }
      return item;
    }) ?? "null";
  }
  const requestBudget = budget(8_000, "User request");
  const promptBudget = budget(32_000, "Model requests");
  const toolBudget = budget(16_000, "Tool traffic");
  const outputBudget = budget(12_000, "Final output");
  const artifactBudget = budget(2_000, "Artifact metadata");
  const warningBudget = budget(2_000, "Run warnings");
  const evidence: RunEvidence = {
    request: requestBudget(json(messages)),
    // No provider credentials, binding headers, or configuration ciphertext.
    savedBindings: budget(4_000, "Saved bindings")(json({ model: configuration.model,
      skills: configuration.skillList, tools: configuration.mcpList.map(({ name, tools }) => ({ name, tools })),
      subagents: configuration.subagentList })),
    capabilities: capabilities.evidence,
    modelRequests: [], toolTraffic: [], output: "", artifacts: [], warnings: [], limitations: [],
  };
  function append(list: string[], value: unknown, bound: (text: string) => string, label: string) {
    if (list.length >= 64) { limitations.add(`${label} entries were omitted.`); return; }
    const text = bound(json(value));
    if (text) list.push(text);
  }
  return {
    onModelRequest(agentName: string, model: string, request: ModelRequest, servers: readonly McpServerInfo[] = []) {
      capabilities.observeRequest(agentName, model, request, servers);
      append(evidence.modelRequests, { agentName, model, instructions: request.systemInstructions,
        input: request.input, tools: request.tools, handoffs: request.handoffs, outputType: request.outputType }, promptBudget, "Model request");
    },
    observe(chunk: EngineChunk) {
      capabilities.observeChunk(chunk);
      if (isTopLevelChunk(chunk)) {
        if (chunk.delta?.content) evidence.output += outputBudget(chunk.delta.content);
        evidence.termination = runTermination(chunk) ?? evidence.termination;
        evidence.traceId = chunk.traceId ?? evidence.traceId;
      }
      if (chunk.delta?.toolCalls || chunk.toolResult || chunk.error) {
        append(evidence.toolTraffic, { author: chunk.author, authorPath: chunk.authorPath, transferId: chunk.transferId,
          calls: chunk.delta?.toolCalls, result: chunk.toolResult, error: chunk.error }, toolBudget, "Tool traffic");
      }
      const warning = collectedWarning(chunk, evidence.warnings);
      if (warning) {
        const text = warningBudget(warning);
        if (text) evidence.warnings.push(text);
      }
      if (chunk.image || chunk.file) {
        limitations.add("Image and file bytes are omitted; their visual/content quality is unverified.");
        append(evidence.artifacts, chunk.file ? { kind: "file", name: chunk.file.name, mimeType: chunk.file.mimeType,
          byteSize: chunk.file.byteSize, fileId: chunk.file.fileId } : { kind: "image", mimeType: chunk.image!.mimeType }, artifactBudget, "Artifact");
      }
    },
    finish() {
      if (!capabilities.evidence.inventoryComplete) limitations.add("Some offered capability sets were omitted; absence from the inventory is not proof of unavailability.");
      if (!capabilities.evidence.activityComplete) limitations.add("Some per-capability request counts were omitted; total call and result counts remain complete.");
      if (!evidence.modelRequests.length) limitations.add("No model request was captured.");
      if (!evidence.termination) limitations.add("The run did not report a terminal outcome.");
      evidence.limitations = [...limitations];
      return evidence;
    },
  };
}
