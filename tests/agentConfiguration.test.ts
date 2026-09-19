import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeStore } from "./fakeStore";
import type { Project } from "@/domain/project/types";
import { agentMcpHeadersContext } from "@/domain/security/secretContext";
import { createConfigurationUseCases, type AgentConfigurationInput } from "@/application/project/configurationUseCases";
import { setAdminCheck, updateProject } from "@/application/project/projectUseCases";
import { projectRepository } from "@/infrastructure/db/repositories/projectRepository";
import { mcpRepository } from "@/infrastructure/db/repositories/mcpRepository";
import { skillRepository } from "@/infrastructure/db/repositories/skillRepository";
import { externalAgentRepository } from "@/infrastructure/db/repositories/externalAgentRepository";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import { keys } from "@/infrastructure/db/keys";
import { putAgentConfigurationSchema } from "@/app/api/projects/_lib/schemas";
import { sanitizeProject } from "@/app/api/projects/_lib/http";

vi.mock("@/infrastructure/db/store", async () => (await import("./fakeStore")).createFakeStore());
vi.mock("node:crypto", async (original) => ({
  ...(await original<typeof import("node:crypto")>()),
  randomBytes: (size: number) => Buffer.alloc(size, 17),
}));
const store = await import("@/infrastructure/db/store") as unknown as FakeStore;

const OWNER = "owner@example.test";
const READER = "reader@example.test";
const ADMIN = "admin@example.test";
const NOW = "2026-09-19T12:00:00.000Z";
const SECRET = "Bearer synthetic-configuration-credential";
const project: Project = {
  name: "agent", displayName: "Agent", description: "", projectType: "agent",
  ownerEmail: OWNER, createdAt: NOW, updatedAt: NOW,
};
const input = (overrides: Partial<AgentConfigurationInput> = {}): AgentConfigurationInput => ({
  systemPrompt: "Be helpful", model: "openai/gpt-5-mini", parameters: { piiFiltering: true },
  mcpList: [], skillList: [], subagentList: [], ...overrides,
});
const useCases = createConfigurationUseCases({
  projects: projectRepository, cipher: secretCipher,
  refs: { projects: projectRepository, mcps: mcpRepository,
    skills: skillRepository, externalAgents: externalAgentRepository },
});

async function save(overrides: Partial<AgentConfigurationInput> = {}, expectedUpdatedAt = NOW, email = OWNER) {
  return useCases.put(project.name, { ...input(overrides), expectedUpdatedAt }, email);
}

async function seedMcp(url = "https://tools.example.test/mcp") {
  await store.putItem({ ...keys.mcp("tools"), entityType: "MCP", name: "tools", url,
    description: "Tools", headers: {}, createdAt: NOW, updatedAt: NOW });
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("AES_ENCRYPTION_KEY", Buffer.alloc(32, 9).toString("base64"));
  setAdminCheck(async email => email === ADMIN);
  store.rows.clear();
  await projectRepository.create(project);
});
afterEach(() => {
  setAdminCheck(async () => false);
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("current Agent configuration", () => {
  it("stores one configuration with the Project without creating or publishing a Version", async () => {
    expect(await useCases.getView(project.name, READER)).toEqual({ configuration: null, updatedAt: NOW });
    const saved = await save();
    const stored = await projectRepository.get(project.name);
    expect(stored?.configuration).toEqual({ projectName: project.name, ...input() });
    expect(saved.updatedAt).not.toBe(NOW);
    expect(stored?.publishedVersion).toBeUndefined();
    expect([...store.rows.values()].some(row => row.entityType === "VERSION")).toBe(false);
    expect(saved.configuration).not.toHaveProperty("versionName");
    expect(saved.configuration).not.toHaveProperty("createdAt");
    expect(saved.configuration).not.toHaveProperty("userPromptTemplate");
  });

  it("rejects stale editor state and permits only one concurrent writer", async () => {
    const results = await Promise.allSettled([save({ systemPrompt: "A" }), save({ systemPrompt: "B" })]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    const winner = await projectRepository.get(project.name);
    await expect(save({ systemPrompt: "stale" })).rejects.toMatchObject({ status: 409 });
    expect(await projectRepository.get(project.name)).toEqual(winner);
  });

  it("preserves an execution snapshot and current settings through metadata edits", async () => {
    const first = await save({ maxTurn: 12, fallbackModel: "openai/gpt-5-mini" });
    const snapshot = (await projectRepository.get(project.name))!.configuration!;
    await save({ systemPrompt: "Next request" }, first.updatedAt);
    const updated = await updateProject(projectRepository, project.name, { description: "Updated" }, OWNER);
    expect(snapshot.systemPrompt).toBe("Be helpful");
    expect(updated.configuration?.systemPrompt).toBe("Next request");
    expect(updated.configuration?.maxTurn).toBeUndefined();
    expect(updated.configuration?.fallbackModel).toBeUndefined();
    await expect(save({}, first.updatedAt)).rejects.toMatchObject({ status: 409 });
  });

  it("keeps write ownership and private-project reads at the existing boundaries", async () => {
    await expect(save({}, NOW, READER)).rejects.toMatchObject({ status: 403 });
    const adminSave = await save({}, NOW, ADMIN);
    const privateProject = await updateProject(projectRepository, project.name, { visibility: "private" }, OWNER);
    await expect(useCases.getView(project.name, READER)).rejects.toMatchObject({ status: 403 });
    expect((await useCases.getView(project.name, ADMIN)).configuration).toEqual(adminSave.configuration);
    expect(privateProject.configuration).toBeDefined();
    await expect(useCases.getView("missing", OWNER)).rejects.toMatchObject({ status: 404 });
  });

  it("encrypts credentials in the Agent context and removes internal settings from Project responses", async () => {
    await seedMcp();
    const saved = await save({ mcpList: [{ name: "tools", headers: { Authorization: SECRET }, tools: ["lookup"] }] });
    const stored = (await projectRepository.get(project.name))!;
    const headers = stored.configuration!.mcpList[0]!.headers!;
    expect(headers.Authorization).toMatch(/^enc:v2:/);
    expect(secretCipher.maskHeaderOverrides(headers, agentMcpHeadersContext(project.name, "tools")))
      .toEqual(saved.configuration!.mcpList[0]!.headers);
    expect(secretCipher.decryptHeadersForOutbound(headers as Record<string, string>,
      agentMcpHeadersContext(project.name, "tools")).Authorization).toBe(SECRET);
    expect(() => secretCipher.decryptHeadersForOutbound(headers as Record<string, string>,
      agentMcpHeadersContext("another-project", "tools"))).toThrow();
    expect(JSON.stringify(saved)).not.toContain(SECRET);
    expect(saved.configuration!.mcpList[0]).not.toHaveProperty("headerTarget");
    expect(sanitizeProject(stored)).not.toHaveProperty("configuration");
    expect(sanitizeProject(stored, { withMemberEmails: true })).not.toHaveProperty("configuration");
  });

  it("preserves masked and omitted headers, permits explicit clearing, and never creates a secret from a mask", async () => {
    await seedMcp();
    const first = await save({ mcpList: [{ name: "tools", headers: { Authorization: SECRET } }] });
    const masked = first.configuration!.mcpList;
    const second = await save({ mcpList: masked }, first.updatedAt);
    const third = await save({ mcpList: [{ name: "tools", tools: ["lookup"] }] }, second.updatedAt);
    expect(third.configuration!.mcpList[0]!.headers).toEqual(masked[0]!.headers);
    const cleared = await save({ mcpList: [{ name: "tools", headers: {} }] }, third.updatedAt);
    expect(cleared.configuration!.mcpList[0]).not.toHaveProperty("headers");
    const unmatched = await save({ mcpList: masked }, cleared.updatedAt);
    expect(unmatched.configuration!.mcpList[0]).not.toHaveProperty("headers");
  });

  it("never carries a saved secret to a changed MCP endpoint, including draft preview", async () => {
    await seedMcp();
    const first = await save({ mcpList: [{ name: "tools", headers: { Authorization: SECRET } }] });
    await seedMcp("https://replacement.example.test/mcp");
    const preview = await useCases.resolveDraftBindings(project.name, first.configuration!.mcpList, OWNER);
    expect(preview[0]).not.toHaveProperty("headers");
    const saved = await save({ mcpList: first.configuration!.mcpList }, first.updatedAt);
    expect(saved.configuration!.mcpList[0]).not.toHaveProperty("headers");
  });

  it("validates capabilities, duplicate bindings and newly added inaccessible references", async () => {
    await expect(save({ model: "openai/gpt-image-2" })).rejects.toMatchObject({ status: 400 });
    await expect(save({ model: "openai/o1-pro" })).rejects.toThrow("tool calling");
    await expect(save({ skillList: ["missing"] })).rejects.toThrow("does not exist");
    await expect(save({ mcpList: [{ name: "tools" }, { name: "tools" }] })).rejects.toThrow("more than once");
    await projectRepository.create({ ...project, name: "private-child", ownerEmail: READER, visibility: "private" });
    await expect(save({ subagentList: [{ name: "private-child", type: "local" }] })).rejects.toThrow("private");
    expect((await projectRepository.get(project.name))!.configuration).toBeUndefined();
  });

  it("retains the ability to edit away a binding after its registry entry disappears", async () => {
    await seedMcp();
    const first = await save({ mcpList: [{ name: "tools" }] });
    await store.deleteItem(keys.mcp("tools"));
    const second = await save({ systemPrompt: "Changed", mcpList: first.configuration!.mcpList }, first.updatedAt);
    expect(second.configuration!.mcpList).toEqual([{ name: "tools" }]);
    expect((await save({}, second.updatedAt)).configuration!.mcpList).toEqual([]);
  });

  it("rejects a stored configuration belonging to another Project", async () => {
    await store.updateItem(keys.project(project.name), row => ({ ...row!, configuration: { ...input(), projectName: "other" } }));
    await expect(projectRepository.get(project.name)).rejects.toThrow("belongs to another Project");
  });

  it("requires the editor revision and rejects retired Version fields at the HTTP boundary", () => {
    expect(putAgentConfigurationSchema.safeParse(input()).success).toBe(false);
    for (const retired of [{ versionName: "2" }, { userPromptTemplate: "{{task}}" }, { publishedVersion: "2" }]) {
      expect(putAgentConfigurationSchema.safeParse({ ...input(), expectedUpdatedAt: NOW, ...retired }).success).toBe(false);
    }
    expect(putAgentConfigurationSchema.safeParse({ ...input(), expectedUpdatedAt: NOW }).success).toBe(true);
  });
});
