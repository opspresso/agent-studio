import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyAgentMigration, loadMigrationModelRegistry, migrationProjectNames, planAgentMigration } from "../scripts/agent-configuration-migration";
import snapshot from "@/domain/llm/catalog.json";
import { loadModelCatalog, loadSelfHostedModels } from "@/domain/llm/models";
import { agentMcpHeadersContext, versionMcpHeadersContext } from "@/domain/security/secretContext";
import { keys } from "@/infrastructure/db/keys";
import * as store from "@/infrastructure/db/store";
import { projectRepository } from "@/infrastructure/db/repositories/projectRepository";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import { createFakeStore } from "./fakeStore";

vi.mock("@/infrastructure/db/store", async () => (await import("./fakeStore")).createFakeStore());
vi.mock("node:crypto", async original => ({
  ...(await original<typeof import("node:crypto")>()), randomBytes: (size: number) => Buffer.alloc(size, 17),
}));
const fake = store as unknown as ReturnType<typeof createFakeStore>;
const NOW = "2026-09-19T00:00:00.000Z";
const project = (extra = {}) => ({ ...keys.project("demo"), entityType: "PROJECT", name: "demo", displayName: "Demo",
  GSI1PK: keys.typePartition("PROJECT"), GSI1SK: "demo", projectType: "agent", ownerEmail: "owner@example.test",
  visibility: "private", memberEmails: ["member@example.test"], createdAt: NOW, updatedAt: NOW, ...extra });
const version = (name: string, extra = {}) => ({ ...keys.version("demo", name), entityType: "VERSION", projectName: "demo",
  versionName: name, systemPrompt: `Prompt ${name}`, userPromptTemplate: "", model: "openai/gpt-5-mini",
  parameters: { piiFiltering: true }, mcpList: [], skillList: [], subagentList: [], createdAt: NOW, ...extra });

beforeEach(() => {
  fake.rows.clear(); vi.useFakeTimers(); vi.setSystemTime(NOW);
  vi.stubEnv("AES_ENCRYPTION_KEY", Buffer.alloc(32, 9).toString("base64"));
});
afterEach(() => {
  loadSelfHostedModels([]); loadModelCatalog(snapshot, { maxDropFraction: 1 });
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks();
});

describe("offline Agent configuration migration", () => {
  it("uses deployment-owned image model declarations without a public request", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network is unavailable"));
    const id = "selfhosted/migration-image";
    fake.seed([project({ projectType: "image" }), version("1", { model: id }), {
      ...keys.settings(), selfHostedModels: [{ id, provider: "selfhosted", family: "migration-image", maker: "local",
        displayName: "Local image", pricing: { inputPer1M: 0, outputPer1M: 0 }, contextWindow: 0, maxTokens: 0,
        capabilities: { tools: false, structuredOutput: false, imageInput: true, imageGeneration: true, reasoning: false } }],
    }]);
    const overrides = { model: "openai/gpt-5-mini" };
    expect((await planAgentMigration("demo", overrides)).status).toBe("blocked");
    await loadMigrationModelRegistry();
    const plan = await planAgentMigration("demo", overrides);
    expect(plan.status).toBe("ready");
    await applyAgentMigration("demo", plan.expectedFingerprint, secretCipher, overrides);
    expect((await projectRepository.get("demo"))?.configuration?.parameters.imageModel).toBe(id);
    expect(network).not.toHaveBeenCalled();
  });

  it("honors an operator's installed catalog even when it is older and smaller", async () => {
    const image = snapshot.models.find(model => model.id === "openai/gpt-image-2")!;
    const text = snapshot.models.find(model => model.id === "openai/gpt-5-mini")!;
    const id = "openai/operator-image";
    fake.seed([project({ projectType: "image" }), version("1", { model: id }), {
      ...keys.modelCatalog(), document: { ...snapshot, updatedAt: "2026-01-01T00:00:00.000Z",
        models: [text, { ...image, id, family: "operator-image" }] }, uploadedAt: NOW,
    }]);
    await loadMigrationModelRegistry();
    expect((await planAgentMigration("demo", { model: text.id })).status).toBe("ready");
  });

  it("refuses a declared model without Agent tools instead of treating it as an unknown ID", async () => {
    const id = "selfhosted/migration-text";
    fake.seed([project({ projectType: "llm" }), version("1", { model: id }), {
      ...keys.settings(), selfHostedModels: [{ id, provider: "selfhosted", family: "migration-text", maker: "local",
        displayName: "Local text", pricing: { inputPer1M: 0, outputPer1M: 0 }, contextWindow: 32768, maxTokens: 8192,
        capabilities: { tools: false, structuredOutput: false, imageInput: false, reasoning: false } }],
    }]);
    await loadMigrationModelRegistry();
    expect((await planAgentMigration("demo")).status).toBe("blocked");
  });

  it("stops on stored model read failures before changing any project", async () => {
    fake.seed([project(), version("1")]);
    const before = structuredClone([...fake.rows.values()]);
    vi.spyOn(store, "getItem").mockRejectedValueOnce(new Error("Database unavailable"));
    await expect(loadMigrationModelRegistry()).rejects.toThrow("Database unavailable");
    expect([...fake.rows.values()]).toEqual(before);
  });

  it("plans without writes and preserves every source when applying the published selection", async () => {
    const meta = project({ publishedVersion: "1" });
    const first = version("1"); const second = version("2", { createdAt: "2026-09-20T00:00:00.000Z" });
    fake.seed([meta, first, second]);
    const before = structuredClone([...fake.rows.values()]);
    const plan = await planAgentMigration("demo");
    expect(plan).toMatchObject({ status: "ready", sourceVersion: "1" });
    expect([...fake.rows.values()]).toEqual(before);
    await applyAgentMigration("demo", plan.expectedFingerprint, secretCipher);
    expect(await projectRepository.get("demo")).toMatchObject({ projectType: "agent", visibility: "private",
      memberEmails: ["member@example.test"], configuration: { systemPrompt: "Prompt 1" } });
    expect(await store.getItem(keys.project("demo"))).not.toHaveProperty("publishedVersion");
    expect(await store.getItem(keys.legacyProjectConfiguration("demo"))).toMatchObject({ project: meta });
    expect(await store.getItem(keys.version("demo", "1"))).toEqual(first);
    expect(await store.getItem(keys.version("demo", "2"))).toEqual(second);
    expect(await planAgentMigration("demo")).toMatchObject({ status: "current" });
  });

  it("uses the newest saved configuration across bounded pages when there is no publication", async () => {
    fake.seed([project(), ...Array.from({ length: 125 }, (_, index) => version(String(index).padStart(3, "0"), {
      createdAt: new Date(Date.parse(NOW) + index).toISOString(),
    }))]);
    const read = vi.spyOn(store, "queryItems");
    expect(await planAgentMigration("demo")).toMatchObject({ status: "ready", sourceVersion: "124" });
    expect(read.mock.calls.every(([query]) => query.limit === 100)).toBe(true);
    expect(read.mock.calls.some(([query]) => query.after !== undefined)).toBe(true);
  });

  it("requires an explicit decision for a live user prompt template", async () => {
    fake.seed([project({ projectType: "llm" }), version("1", { userPromptTemplate: "Answer {{topic}}" })]);
    expect(await planAgentMigration("demo")).toMatchObject({ status: "blocked" });
    const overrides = { systemPrompt: "Answer the user's question." };
    const plan = await planAgentMigration("demo", overrides);
    expect(plan.status).toBe("ready");
    await applyAgentMigration("demo", plan.expectedFingerprint, secretCipher, overrides);
    expect((await projectRepository.get("demo"))?.configuration?.systemPrompt).toBe(overrides.systemPrompt);
    expect((await store.getItem(keys.version("demo", "1")))?.userPromptTemplate).toBe("Answer {{topic}}");
  });

  it("moves image generation behind a tool and requires an Agent model", async () => {
    fake.seed([project({ projectType: "image" }), version("1", { model: "openai/gpt-image-2",
      parameters: { piiFiltering: false, size: "1024x1024", quality: "high" } })]);
    expect((await planAgentMigration("demo")).status).toBe("blocked");
    const overrides = { model: "openai/gpt-5-mini" };
    const plan = await planAgentMigration("demo", overrides);
    expect(plan.status).toBe("ready");
    await applyAgentMigration("demo", plan.expectedFingerprint, secretCipher, overrides);
    expect((await projectRepository.get("demo"))?.configuration).toMatchObject({ model: overrides.model,
      parameters: { imageGeneration: true, imageModel: "openai/gpt-image-2" } });
    expect((await projectRepository.get("demo"))?.configuration?.parameters).not.toHaveProperty("size");
  });

  it("reencrypts MCP headers for the stable Agent identity and preserves endpoint and tool restrictions", async () => {
    const oldContext = versionMcpHeadersContext("demo", "1", "tools");
    const headers = secretCipher.mergeHeaderOverrideUpdate({}, { Authorization: "Bearer synthetic-migration", "X-Drop": null }, oldContext);
    fake.seed([project(), version("1", { mcpList: [{ name: "tools", headers, headerTarget: "endpoint-fingerprint", tools: ["lookup"] }] })]);
    const plan = await planAgentMigration("demo");
    expect(JSON.stringify(plan)).not.toContain("synthetic-migration");
    expect(JSON.stringify(plan)).not.toContain("Authorization");
    await applyAgentMigration("demo", plan.expectedFingerprint, secretCipher);
    const binding = (await projectRepository.get("demo"))!.configuration!.mcpList[0]!;
    expect(binding).toMatchObject({ headerTarget: "endpoint-fingerprint", tools: ["lookup"] });
    expect(binding.headers?.Authorization).not.toBe(headers.Authorization);
    expect(secretCipher.mergeOutboundHeaders({}, binding.headers, "unused", agentMcpHeadersContext("demo", "tools")))
      .toEqual({ Authorization: "Bearer synthetic-migration" });
    expect(() => secretCipher.mergeOutboundHeaders({}, binding.headers, "unused", oldContext)).toThrow();
  });

  it("refuses a stale plan after source, metadata or override changes", async () => {
    fake.seed([project(), version("1")]);
    const plan = await planAgentMigration("demo");
    fake.seed([version("1", { systemPrompt: "concurrent edit" })]);
    await expect(applyAgentMigration("demo", plan.expectedFingerprint, secretCipher)).rejects.toThrow("plan changed");
    const next = await planAgentMigration("demo");
    await expect(applyAgentMigration("demo", next.expectedFingerprint, secretCipher, { model: "custom" })).rejects.toThrow("plan changed");
    expect(await store.getItem(keys.legacyProjectConfiguration("demo"))).toBeNull();
  });

  it("leaves sources untouched if encrypted headers cannot be read", async () => {
    fake.seed([project(), version("1", { mcpList: [{ name: "tools", headers: { Authorization: "enc:v2:invalid" } }] })]);
    const before = structuredClone([...fake.rows.values()]);
    const plan = await planAgentMigration("demo");
    await expect(applyAgentMigration("demo", plan.expectedFingerprint, secretCipher)).rejects.toThrow();
    expect([...fake.rows.values()]).toEqual(before);
  });

  it("refuses malformed binding data rather than dropping it during conversion", async () => {
    fake.seed([project(), version("1", { mcpList: ["tools", null] })]);
    expect((await planAgentMigration("demo")).status).toBe("blocked");
  });

  it("rolls back the archive when a metadata writer wins after inspection", async () => {
    fake.seed([project(), version("1")]);
    const plan = await planAgentMigration("demo");
    const original = store.transact;
    vi.spyOn(store, "transact").mockImplementationOnce(async ops => {
      fake.seed([project({ description: "concurrent" })]);
      return original(ops);
    });
    await expect(applyAgentMigration("demo", plan.expectedFingerprint, secretCipher)).rejects.toThrow();
    expect(await store.getItem(keys.legacyProjectConfiguration("demo"))).toBeNull();
    expect((await store.getItem(keys.project("demo")))?.description).toBe("concurrent");
  });

  it.each(["queued", "running", "waiting"])("blocks on %s Audio work", async status => {
    fake.seed([project(), version("1"), { ...keys.audioJob("demo", "job"), job: { status } }]);
    const plan = await planAgentMigration("demo");
    expect(plan.status).toBe("blocked");
    await expect(applyAgentMigration("demo", plan.expectedFingerprint, secretCipher)).rejects.toThrow("Audio jobs");
  });

  it.each([{ payloadMode: "variables" }, { variables: { topic: "fixed" } }])("requires an explicit transition for template automation %j", async input => {
    fake.seed([project(), version("1"), { ...keys.trigger("demo", "webhook"), enabled: true, ...input }]);
    expect((await planAgentMigration("demo")).status).toBe("blocked");
    fake.seed([{ ...keys.trigger("demo", "webhook"), enabled: false, ...input }]);
    expect((await planAgentMigration("demo")).status).toBe("ready");
  });

  it("does not fall back from a dangling publication or overwrite an archive", async () => {
    fake.seed([project({ publishedVersion: "gone" }), version("1")]);
    expect((await planAgentMigration("demo")).status).toBe("blocked");
    fake.seed([project(), { ...keys.legacyProjectConfiguration("demo"), project: { preserved: true } }]);
    expect((await planAgentMigration("demo")).status).toBe("blocked");
  });

  it("archives Audio recipes and refuses to silently replace an active fixed postprocessor", async () => {
    const config = { enabled: true, revision: 4, updatedAt: NOW, postprocess: { projectName: "writer", versionName: "1" }, model: "asr" };
    fake.seed([project(), version("1"), { ...keys.audioJobConfig("demo"), config }]);
    expect((await planAgentMigration("demo")).status).toBe("blocked");
    const recipe = { ...keys.audioJobConfig("demo"), config: { ...config, postprocess: { projectName: "writer", versionName: "published" } } };
    fake.seed([recipe]);
    const plan = await planAgentMigration("demo");
    expect(plan).toMatchObject({ status: "ready", audioRecipe: "current-agent" });
    await applyAgentMigration("demo", plan.expectedFingerprint, secretCipher);
    expect((await store.getItem(keys.audioJobConfig("demo")))?.config).toEqual({ ...config, revision: 5,
      updatedAt: "2026-09-19T00:00:00.001Z", postprocess: { projectName: "writer" } });
    expect((await store.getItem(keys.legacyProjectConfiguration("demo")))?.audioConfig).toEqual(recipe);
  });

  it("converts an empty legacy project without inventing settings and leaves a current empty Agent alone", async () => {
    fake.seed([project({ projectType: "llm" })]);
    const plan = await planAgentMigration("demo");
    await applyAgentMigration("demo", plan.expectedFingerprint, secretCipher);
    expect((await projectRepository.get("demo"))?.configuration).toBeUndefined();
    expect((await projectRepository.get("demo"))?.projectType).toBe("agent");
    expect((await planAgentMigration("demo")).status).toBe("current");
    fake.rows.clear(); fake.seed([project()]);
    expect((await planAgentMigration("demo")).status).toBe("current");
    expect(await store.getItem(keys.legacyProjectConfiguration("demo"))).toBeNull();
  });

  it("enumerates legacy types without decoding them as current Projects", async () => {
    fake.seed([project({ projectType: "image" })]);
    const names = [];
    for await (const name of migrationProjectNames()) names.push(name);
    expect(names).toEqual(["demo"]);
  });
});
