import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeStore } from "./fakeStore";
import { keys } from "@/infrastructure/db/keys";
import { mcpBindingSchema } from "@/app/api/agents/_lib/schemas";

vi.mock("@/infrastructure/db/store", () => createFakeStore());
import * as store from "@/infrastructure/db/store";
import { mcpRepository } from "@/infrastructure/db/repositories/mcpRepository";
import { agentRepository } from "@/infrastructure/db/repositories/agentRepository";
const fake = store as unknown as ReturnType<typeof createFakeStore>;
const mapping = { tool: "asset", namespace: "account", urlPath: ["url"], idPath: ["id"], mimeType: "audio/mpeg" };
beforeEach(() => { fake.rows.clear(); });

describe("source mapping persistence", () => {
  it("round-trips registry defaults and refuses malformed stored defaults", async () => {
    await mcpRepository.put({ name: "files", url: "https://files.example.test/mcp", headers: {}, createdAt: "before", updatedAt: "before", sourceOutputs: [mapping] });
    expect((await mcpRepository.get("files"))?.sourceOutputs).toEqual([mapping]);
    fake.seed([{ ...keys.mcp("files"), sourceOutputs: "invalid" }]);
    await expect(mcpRepository.get("files")).rejects.toThrow("source mappings are invalid");
  });
  it("preserves Agent-owned mappings on repository reads", async () => {
    fake.seed([{ ...keys.agent("audio"), name: "audio", displayName: "Audio", entityType: "AGENT", createdAt: "2026-01-01", updatedAt: "2026-01-01", ownerEmail: "owner@example.test",
      configuration: { agentName: "audio", systemPrompt: "", model: "test", parameters: { piiFiltering: false }, skillList: [], subagentList: [], mcpList: [{ name: "files", sourceOutputs: [mapping] }] } }]);
    expect((await agentRepository.get("audio"))?.configuration?.mcpList[0]?.sourceOutputs).toEqual([mapping]);
  });
  it("rejects malformed stored mappings instead of falling back to raw output", async () => {
    fake.seed([{ ...keys.agent("audio"), name: "audio", displayName: "Audio", entityType: "AGENT", createdAt: "2026-01-01", updatedAt: "2026-01-01", ownerEmail: "owner@example.test",
      configuration: { agentName: "audio", systemPrompt: "", model: "test", parameters: { piiFiltering: false }, skillList: [], subagentList: [], mcpList: [{ name: "files", sourceOutputs: "broken" }] } }]);
    await expect(agentRepository.get("audio")).rejects.toThrow("source mappings are invalid");
  });
  it("rejects duplicate tools and unsafe paths at the API boundary", () => {
    expect(mcpBindingSchema.safeParse({ name: "files", sourceOutputs: [mapping, mapping] }).success).toBe(false);
    expect(mcpBindingSchema.safeParse({ name: "files", sourceOutputs: [{ ...mapping, idPath: ["constructor"] }] }).success).toBe(false);
    expect(mcpBindingSchema.safeParse({ name: "files", sourceOutputs: [mapping] }).success).toBe(true);
  });
});
