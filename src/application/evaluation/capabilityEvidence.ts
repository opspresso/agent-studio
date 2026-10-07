import type { ModelRequest } from "@openai/agents";
import type { McpServerInfo } from "@/application/llm/agentAssembly";
import type { EngineChunk } from "@/domain/llm/types";
import { SKILL_TOOL_NAME } from "@/domain/llm/toolNames";
import type { EvaluationExpectations } from "@/domain/evaluation/types";

interface CapabilitySnapshot {
  agentName: string;
  model: string;
  tools: Array<{ name: string; server?: string }>;
  skills: string[];
}
interface CapabilityCall { agentName: string; name: string; count: number }
export interface CapabilityEvidence {
  /** Unique offered sets; names are retained whole, independently of verbose schemas. */
  snapshots: CapabilitySnapshot[];
  inventoryComplete: boolean;
  activityComplete: boolean;
  modelRequests: number;
  toolCalls: number;
  toolResults: number;
  calls: CapabilityCall[];
  skillCalls: CapabilityCall[];
}
export interface CapabilityObservation {
  kind: "skill" | "tool";
  name: string;
  available: "offered" | "not-offered" | "unknown";
  /** Requests are not proof of success: input validation or dispatch may have failed. */
  requests: number | null;
}

const INVENTORY_CHARS = 24_000;
const ACTIVITY_CHARS = 8_000;
const MAX_SNAPSHOTS = 32;

export function createCapabilityEvidence(rootAgent: string) {
  const evidence: CapabilityEvidence = { snapshots: [], inventoryComplete: true, activityComplete: true,
    modelRequests: 0, toolCalls: 0, toolResults: 0, calls: [], skillCalls: [] };
  const snapshots = new Set<string>();
  let inventoryChars = 0;
  let activityChars = 0;
  function record(list: CapabilityCall[], agentName: string, name: string) {
    const found = list.find(entry => entry.agentName === agentName && entry.name === name);
    if (found) { found.count += 1; return; }
    const entry = { agentName, name, count: 1 };
    const size = JSON.stringify(entry).length;
    if (activityChars + size > ACTIVITY_CHARS) { evidence.activityComplete = false; return; }
    activityChars += size;
    list.push(entry);
  }
  return {
    evidence,
    observeRequest(agentName: string, model: string, request: ModelRequest, servers: readonly McpServerInfo[]) {
      evidence.modelRequests += 1;
      const serverByTool = new Map(servers.flatMap(server => server.toolNames.map(name => [name, server.name] as const)));
      const skill = request.tools.find(tool => tool.type === "function" && tool.name === SKILL_TOOL_NAME);
      const schema = skill?.type === "function" ? skill.parameters as Record<string, unknown> : undefined;
      const properties = schema?.properties as Record<string, { enum?: unknown }> | undefined;
      const names = properties?.skill_name?.enum;
      const snapshot: CapabilitySnapshot = { agentName, model,
        tools: [...request.tools.map(tool => ({ name: tool.name, ...(serverByTool.has(tool.name) ? { server: serverByTool.get(tool.name)! } : {}) })),
          ...request.handoffs.map(tool => ({ name: tool.toolName }))],
        skills: Array.isArray(names) ? names.filter((name): name is string => typeof name === "string") : [],
      };
      const key = JSON.stringify(snapshot);
      if (snapshots.has(key)) return;
      if (snapshots.size >= MAX_SNAPSHOTS || inventoryChars + key.length > INVENTORY_CHARS) {
        evidence.inventoryComplete = false;
        return;
      }
      inventoryChars += key.length;
      snapshots.add(key);
      evidence.snapshots.push(snapshot);
    },
    observeChunk(chunk: EngineChunk) {
      const agentName = chunk.author ?? rootAgent;
      for (const call of chunk.delta?.toolCalls ?? []) {
        evidence.toolCalls += 1;
        if (!call.function?.name) { evidence.activityComplete = false; continue; }
        record(evidence.calls, agentName, call.function.name);
        if (call.function.name === SKILL_TOOL_NAME) {
          // A malformed Skill argument is a request, but cannot identify a loaded skill.
          let args: unknown;
          try { args = JSON.parse(call.function.arguments ?? ""); } catch { continue; }
          if (args && typeof args === "object" && "skill_name" in args && typeof args.skill_name === "string") {
            record(evidence.skillCalls, agentName, args.skill_name);
          }
        }
      }
      if (chunk.toolResult && !chunk.toolResult.displayOnly) evidence.toolResults += 1;
    },
  };
}

/** Resolve explicit expectations from recorded facts, never from the judge's prose. */
export function observeExpectations(evidence: CapabilityEvidence, expectations: EvaluationExpectations): CapabilityObservation[] {
  return (["skill", "tool"] as const).flatMap(kind => (kind === "skill" ? expectations.skills : expectations.tools).map(name => {
    const offered = evidence.snapshots.some(snapshot => kind === "skill" ? snapshot.skills.includes(name)
      : snapshot.tools.some(tool => tool.name === name || tool.server === name));
    let ambiguous = false;
    const requests = (kind === "skill" ? evidence.skillCalls : evidence.calls).reduce((total, call) => {
      if (call.name === name) return total + call.count;
      if (kind === "skill") return total;
      const servers = new Set(evidence.snapshots.filter(snapshot => snapshot.agentName === call.agentName)
        .flatMap(snapshot => snapshot.tools.filter(tool => tool.name === call.name).map(tool => tool.server)));
      if (!servers.has(name)) return total;
      // Separate invocations of one Agent can offer the same alias from different servers.
      if (servers.size > 1) ambiguous = true;
      return total + call.count;
    }, 0);
    return { kind, name, available: offered ? "offered" : evidence.inventoryComplete && evidence.modelRequests > 0 ? "not-offered" : "unknown",
      requests: evidence.activityComplete && evidence.inventoryComplete && !ambiguous ? requests : null };
  }));
}
