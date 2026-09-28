import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCapabilityVisibility } from "@/application/plugin/capabilityVisibility";
import { createPluginUseCases } from "@/application/plugin/pluginUseCases";
import { createSkillUseCases } from "@/application/skill/skillUseCases";
import { createMcpUseCases } from "@/application/mcp/mcpUseCases";
import { syncPluginsFromSnapshot } from "@/application/plugin/syncPlugins";
import { setAuditSink } from "@/application/audit/recordAudit";
import { reindexCatalog } from "@/application/catalog/reindexCatalog";
import { searchCapabilitiesByKind } from "@/application/catalog/searchCatalog";
import { buildSkillLoader, createSkillReader, resolveSkills } from "@/application/execution/bindings";
import { emptyCapabilityVisibility, MAX_HIDDEN_CAPABILITIES } from "@/domain/plugin/visibility";
import { pluginSource, MCP_JSON_SCHEMA, PLUGIN_MANIFEST_SCHEMA } from "@/domain/plugin/types";
import { settingsRepository } from "@/infrastructure/db/repositories/settingsRepository";
import { pluginRepository } from "@/infrastructure/db/repositories/pluginRepository";
import { skillRepository } from "@/infrastructure/db/repositories/skillRepository";
import { mcpRepository } from "@/infrastructure/db/repositories/mcpRepository";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import { fakeSkillRepository } from "./fakeSkills";
import type { FakeStore } from "./fakeStore";
import type { VectorRecord, VectorStorePort } from "@/domain/vector/types";
import type { AuditEvent } from "@/domain/audit/types";
import type { Plugin } from "@/domain/plugin/types";

vi.mock("@/infrastructure/db/store", async () => (await import("./fakeStore")).createFakeStore());
vi.mock("node:crypto", async importOriginal => ({ ...await importOriginal<typeof import("node:crypto")>(),
  randomUUID: () => "00000000-0000-4000-8000-000000000001" }));
const store = await import("@/infrastructure/db/store") as unknown as FakeStore;
const rawSkills = { ...skillRepository, describe: fakeSkillRepository(skillRepository.get).describe };
const access = createCapabilityVisibility({ settings: settingsRepository, plugins: pluginRepository, skills: rawSkills, mcps: mcpRepository });
const NOW = "2026-09-28T00:00:00.000Z";
const source = pluginSource("org/repo", "devops");
const plugin: Plugin = { name: "devops", repo: "org/repo", branch: "main", rootPath: "", commitSha: "abc",
  skills: ["deploy"], mcpServers: ["cluster"], syncedAt: NOW, createdAt: NOW, updatedAt: NOW };
let audits: AuditEvent[];

beforeEach(async () => {
  store.rows.clear();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  audits = [];
  setAuditSink({ async append(event) { audits.push(event); }, async listByDay() { return []; } });
  await pluginRepository.put(plugin);
  for (const name of ["deploy", "manual"]) await rawSkills.put({ name, description: `Description of ${name}`,
    content: `Body of ${name}`, ...(name === "deploy" ? { source } : {}), createdAt: NOW, updatedAt: NOW });
  await mcpRepository.put({ name: "cluster", url: "https://example.test/mcp", headers: { Authorization: "private" }, source, createdAt: NOW, updatedAt: NOW });
});
afterEach(() => { setAuditSink(undefined); vi.useRealTimers(); });

describe("deployment capability visibility", () => {
  it("enables all installed Plugins, Skills and Tools when no usage policy has been saved", async () => {
    expect((await access.getView()).hidden).toEqual(emptyCapabilityVisibility());
    expect((await access.plugins.list(100)).map(plugin => plugin.name)).toEqual(["devops"]);
    expect((await access.skills.list(100)).map(skill => skill.name)).toEqual(["deploy", "manual"]);
    expect((await access.mcps.list(100)).map(server => server.name)).toEqual(["cluster"]);
  });
  it("hides a plugin and its current components across list, detail and runtime description reads", async () => {
    await access.update({ plugins: ["devops"], skills: [], tools: [] }, "admin@example.test");
    expect(await access.plugins.list(100)).toEqual([]);
    expect(await access.plugins.get("devops")).toBeNull();
    expect((await access.skills.list(100)).map(skill => skill.name)).toEqual(["manual"]);
    expect(await access.skills.get("deploy")).toBeNull();
    expect(await access.skills.describe(["deploy", "manual"])).toEqual([{ name: "manual", description: "Description of manual" }]);
    expect(await access.mcps.get("cluster")).toBeNull();
    expect(await access.mcps.list(100)).toEqual([]);
    await expect(createPluginUseCases(access.plugins).get("devops")).rejects.toThrow("Plugin not found");
    await expect(createSkillUseCases(access.skills).get("deploy")).rejects.toThrow("Skill not found");
    expect(await resolveSkills({ skills: access.skills }, ["deploy"])).toMatchObject({ skills: [], warnings: [expect.any(String)] });
  });

  it("offers hidden items only in the admin view without exposing content, URLs or credentials", async () => {
    const view = await access.update({ plugins: ["devops", "devops"], skills: ["manual"], tools: [] }, "admin@example.test");
    expect(view.hidden).toEqual({ plugins: ["devops"], skills: ["manual"], tools: [] });
    expect(view.skills).toContainEqual({ name: "deploy", description: "Description of deploy", plugin: "devops" });
    expect(view.tools).toEqual([{ name: "cluster", description: "", plugin: "devops" }]);
    expect(JSON.stringify(view)).not.toMatch(/private|example\.test|Body of/);
    expect(audits.at(-1)).toMatchObject({ action: "settings.update", actorEmail: "admin@example.test", detail: "capabilityVisibility" });
  });

  it("hides individual skills and tools while keeping the plugin and unrelated manual items visible", async () => {
    await access.update({ plugins: [], skills: ["deploy"], tools: ["cluster"] }, "admin@example.test");
    expect(await access.plugins.get("devops")).toMatchObject({ skills: [], mcpServers: [] });
    expect(await access.skills.get("deploy")).toBeNull();
    expect(await access.skills.get("manual")).not.toBeNull();
    expect(await access.mcps.get("cluster")).toBeNull();
    expect(await rawSkills.get("deploy")).not.toBeNull();
    expect(await mcpRepository.get("cluster")).not.toBeNull();
  });

  it("fills pages beyond hidden rows, preserving the complete registry traversal", async () => {
    for (let index = 0; index < 105; index++) await rawSkills.put({ name: `skill-${String(index).padStart(3, "0")}`,
      description: "", content: "", createdAt: NOW, updatedAt: NOW });
    await access.update({ plugins: ["devops"], skills: ["manual", "skill-000", "skill-001"], tools: [] }, "admin@example.test");
    const listed = await createSkillUseCases(access.skills).list();
    expect(listed).toHaveLength(103);
    expect(listed[0]?.name).toBe("skill-002");
    expect(listed.at(-1)?.name).toBe("skill-104");
    expect(await access.skills.list(0)).toEqual([]);
  });

  it("preserves independent selections and other settings through registry sync writes and unhide", async () => {
    await settingsRepository.update(() => ({ updatedAt: NOW, pluginsRepo: "org/repo", embeddingModel: "embedding" }));
    await access.update({ plugins: ["devops"], skills: ["deploy"], tools: [] }, "admin@example.test");
    await pluginRepository.put({ ...plugin, commitSha: "new" });
    await rawSkills.put({ ...(await rawSkills.get("deploy"))!, content: "New content" });
    expect(await access.skills.get("deploy")).toBeNull();
    await access.update({ plugins: [], skills: ["deploy"], tools: [] }, "admin@example.test");
    expect(await access.plugins.get("devops")).not.toBeNull();
    expect(await access.skills.get("deploy")).toBeNull();
    expect(await access.mcps.get("cluster")).not.toBeNull();
    expect(await settingsRepository.get()).toMatchObject({ pluginsRepo: "org/repo", embeddingModel: "embedding" });
  });

  it("syncs hidden registry rows through raw use cases without resetting the deployment policy", async () => {
    const hidden = { plugins: ["devops"], skills: ["manual"], tools: [] };
    await access.update(hidden, "admin@example.test");
    const mcps = createMcpUseCases(mcpRepository, secretCipher, { async assertAllowed() {} }, {
      async listTools() { throw new Error("sync does not probe MCP tools"); }, invalidateDiscovery() {},
    });
    const snapshot = { repo: "org/repo", branch: "main", commitSha: "updated", nestedRoots: [], plugins: [{
      rootPath: "", manifestRaw: JSON.stringify({ $schema: PLUGIN_MANIFEST_SCHEMA, name: "devops" }),
      mcpJsonRaw: JSON.stringify({ $schema: MCP_JSON_SCHEMA, mcpServers: { cluster: { type: "streamable-http", url: "https://example.test/mcp" } } }),
      skills: [{ name: "deploy", path: "skills/deploy/SKILL.md", content: "---\nname: deploy\ndescription: Updated deployment\n---\nNew deployment instructions", files: [] }],
      mcpDocs: [], skippedAttachments: [], badSkillDirs: [],
    }] };
    const report = await syncPluginsFromSnapshot({ plugins: pluginRepository, pluginRows: createPluginUseCases(pluginRepository),
      skillRepo: rawSkills, skills: createSkillUseCases(rawSkills), mcps }, snapshot, "admin@example.test");
    expect(report.plugins[0]?.skills.overwritten).toContainEqual(expect.objectContaining({ name: "deploy" }));
    expect((await pluginRepository.get("devops"))?.commitSha).toBe("updated");
    expect((await rawSkills.get("deploy"))?.content).toBe("New deployment instructions");
    expect((await settingsRepository.get())?.capabilityVisibility).toEqual(hidden);
    expect(await access.skills.get("deploy")).toBeNull();
    expect(await access.mcps.get("cluster")).toBeNull();
    expect(await access.plugins.list(100)).toEqual([]);
  });

  it("rejects malformed names and oversized selections without changing settings", async () => {
    await expect(access.update({ plugins: [], skills: ["Invalid Name"], tools: [] }, "admin@example.test")).rejects.toThrow("Invalid capability visibility");
    await expect(access.update({ plugins: Array(MAX_HIDDEN_CAPABILITIES + 1).fill("devops"), skills: [], tools: [] }, "admin@example.test")).rejects.toThrow("Invalid capability visibility");
    expect(await settingsRepository.get()).toBeNull();
  });

  it("blocks an already cached skill body after the administrator hides it", async () => {
    const load = buildSkillLoader(createSkillReader({ skills: access.skills }));
    expect(await load("deploy")).toBe("Body of deploy");
    await access.update({ plugins: ["devops"], skills: [], tools: [] }, "admin@example.test");
    expect(await load("deploy")).toContain("not found");
    await access.update(emptyCapabilityVisibility(), "admin@example.test");
    expect(await load("deploy")).toBe("Body of deploy");
  });

  it("removes hidden vectors on reindex and inserts restored items on the next rebuild", async () => {
    const records = new Map<string, VectorRecord>();
    const catalog: VectorStorePort = {
      async upsert(next) { next.forEach(record => records.set(record.key, record)); },
      async deleteByKeys(keys) { keys.forEach(key => records.delete(key)); },
      async listKeys() { return [...records.keys()]; },
      async query() { return []; },
    };
    const probe = vi.fn(async () => [{ name: "status", inputSchema: {} }]);
    const deps = { skills: access.skills, mcps: access.mcps, probeMcpTools: probe,
      embeddings: { embed: async (texts: readonly string[]) => texts.map(() => [1]) }, catalog };
    await reindexCatalog(deps);
    expect([...records.keys()]).toEqual(["skill#deploy", "skill#manual", "mcpServer#cluster", "mcpTool#cluster#status"]);
    probe.mockClear();
    await access.update({ plugins: ["devops"], skills: [], tools: [] }, "admin@example.test");
    await reindexCatalog(deps);
    expect([...records.keys()]).toEqual(["skill#manual"]);
    expect(probe).not.toHaveBeenCalled();
    await access.update(emptyCapabilityVisibility(), "admin@example.test");
    expect([...records.keys()]).toEqual(["skill#manual"]);
    await reindexCatalog(deps);
    expect(records.has("skill#deploy")).toBe(true);
    expect(records.has("mcpTool#cluster#status")).toBe(true);
  });

  it("filters stale hidden vectors before ranking so visible results retain their slots", async () => {
    await access.update({ plugins: ["devops"], skills: [], tools: [] }, "admin@example.test");
    const rerank = vi.fn(async (_query, documents: readonly string[]) => ({ scores: documents.map(() => 1) }));
    const result = await searchCapabilitiesByKind({
      embeddings: { embed: async () => [[1]] }, filterEntries: access.filterCatalogEntries,
      reranker: { rerank }, minScore: 0,
      catalog: { async upsert() {}, async deleteByKeys() {}, async listKeys() { return []; }, async query() {
        return ["deploy", "manual"].map((name, index) => ({ key: `skill#${name}`, score: 1 - index * 0.4,
          metadata: { kind: "skill", name, description: name } }));
      } },
    }, ["deploy"], [{ kind: "skill", limit: 1 }]);
    expect(result.matches[0]?.map(entry => entry.name)).toEqual(["manual"]);
    expect(rerank.mock.calls[0]?.[1]).toEqual([expect.stringContaining("manual")]);
  });
});
