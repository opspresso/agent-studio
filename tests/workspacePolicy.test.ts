import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeStore } from "./fakeStore";
import * as store from "@/infrastructure/db/store";
import { keys } from "@/infrastructure/db/keys";
import { projectRepository as projects } from "@/infrastructure/db/repositories/projectRepository";
import { workspacePolicyRepository as repository } from "@/infrastructure/db/repositories/workspacePolicyRepository";
import { createWorkspaceRepositoryPolicyUseCases } from "@/application/workspace/repositoryPolicy";
import { workspaceAllowsRepository, withWorkspaceRepositoryRules, type WorkspaceProjectPolicy } from "@/domain/workspace/policy";
import { getWorkspaceProjectPolicy } from "@/lib/runtime-settings";

vi.mock("@/infrastructure/db/store", () => createFakeStore());
const fake = store as unknown as ReturnType<typeof createFakeStore>;
const now = new Date("2026-09-15T00:00:00Z");
const owner = "owner@example.test";
const deployment: WorkspaceProjectPolicy = { projectName: "demo", runtimes: ["codex"], repository: "company/old", checks: [], deploymentWorkflows: [] };
const api = createWorkspaceRepositoryPolicyUseCases({ projects, repository, deploymentPolicy: name => name === "demo" ? deployment : undefined,
  isAdmin: async email => email === owner, now: () => now });

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now); fake.rows.clear();
  vi.stubEnv("WORKSPACE_CONFIG", JSON.stringify({ image: "workspace:test", projects: [deployment] }));
  fake.seed([{ ...keys.project("demo"), entityType: "PROJECT", name: "demo", displayName: "Demo", projectType: "agent", ownerEmail: owner,
    visibility: "public", createdAt: now.toISOString(), updatedAt: now.toISOString() }]);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("Workspace repository access policy", () => {
  it("allows exact repository owners, including new names, without matching neighboring owners or URLs", () => {
    const rules = { repositoryOwners: ["NALBAM"] };
    expect(workspaceAllowsRepository(rules, "nalbam/not-created-yet")).toBe(true);
    for (const repo of ["nalbam-evil/repo", "evil/nalbam", "nalbam/../repo", "https://github.com/nalbam/repo", "nalbam/..", "nalbam/"]) {
      expect(workspaceAllowsRepository(rules, repo)).toBe(false);
    }
    expect(workspaceAllowsRepository({ repositories: ["Company/Repo"] }, "company/repo")).toBe(true);
    expect(workspaceAllowsRepository({ repositories: ["company/repo"] }, "company/repo-other")).toBe(false);
  });

  it("shares persisted changes across fresh runtime reads and keeps an empty override distinct from deployment fallback", async () => {
    expect(workspaceAllowsRepository((await getWorkspaceProjectPolicy("demo"))!, "company/old")).toBe(true);
    const saved = await api.update("demo", { revision: null, rules: { repositories: [" Company/One ", "company/one"], repositoryOwners: ["NALBAM"] } }, owner);
    expect(saved).toMatchObject({ source: "override", revision: 1, rules: { repositories: ["company/one"], repositoryOwners: ["nalbam"] } });
    const effective = (await getWorkspaceProjectPolicy("demo"))!;
    expect(effective.repository).toBeUndefined();
    expect(workspaceAllowsRepository(effective, "company/old")).toBe(false);
    expect(workspaceAllowsRepository(effective, "nalbam/dalada-3d")).toBe(true);
    await api.update("demo", { revision: 1, rules: {} }, owner);
    expect(workspaceAllowsRepository((await getWorkspaceProjectPolicy("demo"))!, "nalbam/dalada-3d")).toBe(false);
    expect(workspaceAllowsRepository((await getWorkspaceProjectPolicy("demo"))!, "company/old")).toBe(false);
    const reset = await api.update("demo", { revision: 2, rules: null }, owner);
    expect(reset).toMatchObject({ source: "deployment", revision: 3 });
    expect(workspaceAllowsRepository((await getWorkspaceProjectPolicy("demo"))!, "company/old")).toBe(true);
    expect(await getWorkspaceProjectPolicy("not-enabled")).toBeUndefined();
  });

  it("refuses non-admin writes and stale edits, including edits from before a reset", async () => {
    await expect(api.update("demo", { revision: null, rules: { repositoryOwners: ["nalbam"] } }, "member@example.test")).rejects.toMatchObject({ status: 403 });
    expect(await repository.get("demo")).toBeNull();
    await api.update("demo", { revision: null, rules: {} }, owner);
    await expect(api.update("demo", { revision: null, rules: { repositoryOwners: ["nalbam"] } }, owner)).rejects.toMatchObject({ status: 409 });
    await api.update("demo", { revision: 1, rules: null }, owner);
    await expect(api.update("demo", { revision: 1, rules: {} }, owner)).rejects.toMatchObject({ status: 409 });
  });

  it("preserves compute settings and never enables a deployment-disabled project", async () => {
    expect(withWorkspaceRepositoryRules(deployment, { repositoryOwners: ["nalbam"] })).toMatchObject({ runtimes: ["codex"], checks: [], deploymentWorkflows: [] });
    await projects.create({ name: "disabled", displayName: "Disabled", description: "", ownerEmail: owner, projectType: "agent", createdAt: now.toISOString(), updatedAt: now.toISOString() });
    await expect(api.update("disabled", { revision: null, rules: {} }, owner)).rejects.toMatchObject({ status: 400 });
    expect(await api.getView("disabled", owner)).toMatchObject({ enabled: false });
  });

  it.each([{ repository: "https://internal/repo" }, { repositoryOwners: ["*"] }, { repositoryOwners: ["nalbam/*"] }, { repositories: ["nalbam/*"] }, { repositoryOwners: Array(101).fill("nalbam") }])("rejects invalid or unbounded rules %j", async rules => {
    await expect(api.update("demo", { revision: null, rules }, owner)).rejects.toMatchObject({ status: 400 });
    expect(await repository.get("demo")).toBeNull();
  });

  it("fails closed on policy read failure or corrupted stored rules", async () => {
    vi.spyOn(repository, "get").mockRejectedValueOnce(new Error("database unavailable"));
    await expect(getWorkspaceProjectPolicy("demo")).rejects.toThrow("database unavailable");
    fake.seed([{ ...keys.workspacePolicy("demo"), entityType: "WORKSPACEPOLICY", projectName: "demo", revision: 1, updatedAt: now.toISOString(), rules: "invalid" }]);
    await expect(getWorkspaceProjectPolicy("demo")).rejects.toThrow("Invalid Workspace repository access rules");
  });

  it("keeps private project policies private and deletes them with their parent", async () => {
    const project = (await projects.get("demo"))!;
    await projects.update({ ...project, visibility: "private" }, project.updatedAt);
    await expect(api.getView("demo", "foreign@example.test")).rejects.toMatchObject({ status: 403 });
    await api.update("demo", { revision: null, rules: {} }, owner);
    await projects.delete("demo");
    expect(await repository.get("demo")).toBeNull();
    await expect(repository.put({ projectName: "demo", revision: 1, rules: {}, updatedAt: now.toISOString() }, null)).rejects.toThrow();
    expect(await repository.get("demo")).toBeNull();
  });
});
