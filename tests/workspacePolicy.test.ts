import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeStore } from "./fakeStore";
import * as store from "@/infrastructure/db/store";
import { keys } from "@/infrastructure/db/keys";
import { agentRepository as agents } from "@/infrastructure/db/repositories/agentRepository";
import { workspacePolicyRepository as repository } from "@/infrastructure/db/repositories/workspacePolicyRepository";
import { createWorkspaceRepositoryPolicyUseCases } from "@/application/workspace/repositoryPolicy";
import { workspaceAllowsRepository, workspaceAgentPolicy } from "@/domain/workspace/policy";
import type { AgentConfiguration } from "@/domain/agent/types";

vi.mock("@/infrastructure/db/store", () => createFakeStore());
const fake = store as unknown as ReturnType<typeof createFakeStore>;
const now = new Date("2026-09-15T00:00:00Z");
const owner = "owner@example.test";
const configuration: AgentConfiguration = { agentName: "demo", systemPrompt: "", model: "openai/gpt-5-mini", parameters: { piiFiltering: false, workspaceTools: true }, mcpList: [], skillList: [], subagentList: [] };
const api = createWorkspaceRepositoryPolicyUseCases({ agents, repository,
  backendReady: () => true, runtimes: async () => ["command", "codex"], isAdmin: async () => false, now: () => now });
const getWorkspaceAgentPolicy = api.getPolicy;

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now); fake.rows.clear();
  configuration.parameters.workspaceTools = true;
  fake.seed([{ ...keys.agent("demo"), entityType: "AGENT", name: "demo", displayName: "Demo", ownerEmail: owner,
    configuration, visibility: "public", createdAt: now.toISOString(), updatedAt: now.toISOString() }]);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("Workspace repository access policy", () => {
  it("separates fixed, owner, all and new repository access", () => {
    const named = { repositories: ["company/existing"], repositoryOwners: ["company"] };
    expect(workspaceAllowsRepository({ ...named, mode: "selected" }, "company/other")).toBe(false);
    expect(workspaceAllowsRepository({ ...named, mode: "owners" }, "company/other")).toBe(true);
    expect(workspaceAllowsRepository({ mode: "all" }, "different/existing")).toBe(true);
    expect(workspaceAllowsRepository({ mode: "all" }, "https://internal/secret")).toBe(false);
    expect(workspaceAllowsRepository({ ...named, mode: "new" }, "company/existing")).toBe(true);
    expect(workspaceAllowsRepository({ ...named, mode: "new" }, "company/other")).toBe(false);
  });
  it("allows exact repository owners, including new names, without matching neighboring owners or URLs", () => {
    const rules = { mode: "owners" as const, repositoryOwners: ["NALBAM"] };
    expect(workspaceAllowsRepository(rules, "nalbam/not-created-yet")).toBe(true);
    for (const repo of ["nalbam-evil/repo", "evil/nalbam", "nalbam/../repo", "https://github.com/nalbam/repo", "nalbam/..", "nalbam/"]) {
      expect(workspaceAllowsRepository(rules, repo)).toBe(false);
    }
    expect(workspaceAllowsRepository({ repositories: ["Company/Repo"] }, "company/repo")).toBe(true);
    expect(workspaceAllowsRepository({ repositories: ["company/repo"] }, "company/repo-other")).toBe(false);
  });

  it("defaults to registered plus new, without a default repository, and reads saved agent settings", async () => {
    expect(await api.getView("demo", owner)).toMatchObject({ enabled: true, canManage: true, rules: { mode: "new", repositories: [], defaultRuntime: "command" } });
    const saved = await api.update("demo", { revision: null, rules: { mode: "owners", repositories: [" Company/One ", "company/one"], repositoryOwners: ["NALBAM"], defaultRuntime: "codex", idleTtlSeconds: 300 } }, owner);
    expect(saved).toMatchObject({ revision: 1, rules: { repositories: ["company/one"], repositoryOwners: ["nalbam"], defaultRuntime: "codex" } });
    const effective = (await getWorkspaceAgentPolicy("demo"))!;
    expect(effective).not.toHaveProperty("repository");
    expect(workspaceAllowsRepository(effective, "company/old")).toBe(false);
    expect(workspaceAllowsRepository(effective, "nalbam/dalada-3d")).toBe(true);
    await api.update("demo", { revision: 1, rules: { mode: "selected" } }, owner);
    expect(workspaceAllowsRepository((await getWorkspaceAgentPolicy("demo"))!, "nalbam/dalada-3d")).toBe(false);
    expect(await getWorkspaceAgentPolicy("missing")).toBeUndefined();
  });

  it("refuses other members and stale edits", async () => {
    await expect(api.update("demo", { revision: null, rules: { repositoryOwners: ["nalbam"] } }, "member@example.test")).rejects.toMatchObject({ status: 403 });
    expect(await repository.get("demo")).toBeNull();
    await api.update("demo", { revision: null, rules: {} }, owner);
    await expect(api.update("demo", { revision: null, rules: { repositoryOwners: ["nalbam"] } }, owner)).rejects.toMatchObject({ status: 409 });
    await api.update("demo", { revision: 1, rules: {} }, owner);
    await expect(api.update("demo", { revision: 1, rules: {} }, owner)).rejects.toMatchObject({ status: 409 });
  });

  it("requires the agent tool opt-in and a configured default runtime", async () => {
    await expect(api.update("demo", { revision: null, rules: { defaultRuntime: "claude" } }, owner)).rejects.toMatchObject({ status: 400 });
    const agent = (await agents.get("demo"))!;
    await agents.update({ ...agent, configuration: { ...configuration, parameters: { piiFiltering: false, workspaceTools: false } } }, agent.updatedAt);
    await expect(api.update("demo", { revision: null, rules: {} }, owner)).rejects.toMatchObject({ status: 400 });
    expect(await api.getView("demo", owner)).toMatchObject({ enabled: false });
    expect(workspaceAgentPolicy("demo").defaultRuntime).toBe("command");
  });

  it.each([{ repositories: ["https://internal/repo"] }, { repositoryOwners: ["*"] }, { repositoryOwners: ["nalbam/*"] }, { repositories: ["nalbam/*"] }, { repositoryOwners: Array(101).fill("nalbam") }])("rejects invalid or unbounded rules %j", async rules => {
    await expect(api.update("demo", { revision: null, rules }, owner)).rejects.toMatchObject({ status: 400 });
    expect(await repository.get("demo")).toBeNull();
  });

  it("fails closed on policy read failure or corrupted stored rules", async () => {
    vi.spyOn(repository, "get").mockRejectedValueOnce(new Error("database unavailable"));
    await expect(getWorkspaceAgentPolicy("demo")).rejects.toThrow("database unavailable");
    fake.seed([{ ...keys.workspacePolicy("demo"), entityType: "WORKSPACEPOLICY", agentName: "demo", revision: 1, updatedAt: now.toISOString(), rules: "invalid" }]);
    await expect(getWorkspaceAgentPolicy("demo")).rejects.toThrow("Invalid Workspace repository access rules");
  });

  it("keeps private agent policies private and deletes them with their parent", async () => {
    const agent = (await agents.get("demo"))!;
    await agents.update({ ...agent, visibility: "private" }, agent.updatedAt);
    await expect(api.getView("demo", "foreign@example.test")).rejects.toMatchObject({ status: 403 });
    await api.update("demo", { revision: null, rules: {} }, owner);
    await agents.delete("demo");
    expect(await repository.get("demo")).toBeNull();
    await expect(repository.put({ agentName: "demo", revision: 1, rules: {}, updatedAt: now.toISOString() }, null)).rejects.toThrow();
    expect(await repository.get("demo")).toBeNull();
  });
});
