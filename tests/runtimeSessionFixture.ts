import { createToolSchemaValidator } from "@/infrastructure/llm/toolSchema";
import { vi } from "vitest";
import type { RuntimeSessionRepository, RuntimeSessionRow } from "@/domain/execution/runtimeSession";
import type { SecretCipher } from "@/domain/security/secretCipher";
import type { AgentConfiguration } from "@/domain/agent/types";
import { openRuntimeSession, type RuntimeSessionServices } from "@/application/runtime/session";
import { runAgent } from "@/application/runtime";
import type { AgentDeps, RunAgentInput } from "@/application/runtime/types";
import type { EngineChunk } from "@/domain/llm/types";
import { FakeChannel } from "./fakeChannel";

export function runtimeSessionFixture(policy: AgentConfiguration["parameters"]["policy"] = {}) {
  const rows = new Map<string, RuntimeSessionRow>();
  const repository: RuntimeSessionRepository = {
    async get(id, owner) { const row = rows.get(id); return row?.ownerEmail === owner ? structuredClone(row) : null; },
    async save(row, expected) {
      const current = rows.get(row.sessionId);
      if ((current?.revision ?? null) !== expected || current && current.ownerEmail !== row.ownerEmail) return null;
      const revision = (expected ?? 0) + 1;
      rows.set(row.sessionId, { ...row, revision });
      return revision;
    },
    async delete(id) { rows.delete(id); }, async sweepExpired() { return 0; },
  };
  const cipher = {
    encrypt: vi.fn((text: string, context: string) => "enc:v2:" + Buffer.from(JSON.stringify([context, text])).toString("base64")),
    decrypt: vi.fn((data: string, context: string) => { const [saved, text] = JSON.parse(Buffer.from(data.slice("enc:v2:".length), "base64").toString()); if (context !== saved) throw new Error("Cipher context mismatch"); return text as string; }),
  } as unknown as SecretCipher;
  const services: RuntimeSessionServices = { repository, cipher, retentionDays: 30 };
  const configuration: AgentConfiguration = { agentName: "agent",  model: "google/gemini-2.5-flash", systemPrompt: "Instructions",  parameters: { piiFiltering: true, policy }, skillList: [], mcpList: [], subagentList: [], maxTurn: 5 };
  const scope = { sessionId: "chat-1", ownerEmail: "owner@example.com", agentName: "agent", configuration };
  async function run(channel: FakeChannel, message: string, resume?: Parameters<typeof openRuntimeSession>[2], overrides: Partial<AgentDeps> = {}, input: Partial<RunAgentInput> = {}) {
    const runtime = await openRuntimeSession(services, scope, resume);
    runtime.checkBinding("root", "unchanged");
    const chunks: EngineChunk[] = [];
    for await (const chunk of runAgent({ createToolSchemaValidator, channel, ...overrides }, { agentName: "agent", model: configuration.model, parameters: configuration.parameters, maxTurn: 5, messages: [{ role: "user", content: message }], ...input, runtime })) chunks.push(chunk);
    return chunks;
  }
  return { rows, services, scope, configuration, run };
}
