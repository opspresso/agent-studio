import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeStore } from "./fakeStore";
import * as store from "@/infrastructure/db/store";
import { keys } from "@/infrastructure/db/keys";
import { workspacePolicyRepository as policies } from "@/infrastructure/db/repositories/workspacePolicyRepository";
import { workspaceRepositoryCreationStore as creations } from "@/infrastructure/db/repositories/workspaceRepositoryCreationStore";
import { projectRepository } from "@/infrastructure/db/repositories/projectRepository";
import { createWorkspaceRepositoryCreationUseCases } from "@/application/workspace/createRepository";
import { ForbiddenError } from "@/application/errors";
import type { CodingForge } from "@/domain/coding/forge";
import { CodingMutationRejectedError } from "@/domain/coding/types";
import type { WorkspaceProjectPolicy } from "@/domain/workspace/policy";
import { workspaceAllowsRepository, withWorkspaceRepositoryRules } from "@/domain/workspace/policy";
import type { CreateWorkspaceRepositoryInput } from "@/domain/workspace/repositoryCreation";

vi.mock("@/infrastructure/db/store", () => createFakeStore());
const fake = store as unknown as ReturnType<typeof createFakeStore>;
const now = new Date("2026-09-15T08:00:00Z");
const owner = "owner@example.test";
const input = { repository: "company/new-game", description: "A game", private: true };
const created = (request: CreateWorkspaceRepositoryInput) => ({ repository: request.repository, repositoryId: 42, url: `https://github.example.test/${request.repository}`, baseBranch: "main", private: request.private });
const createRepository = vi.fn<NonNullable<CodingForge["createRepository"]>>();
let deployment: WorkspaceProjectPolicy;
async function saveSettings() {
  const current = await policies.get("demo");
  await policies.put({ projectName: "demo", revision: (current?.revision ?? 0) + 1, rules: deployment, updatedAt: now.toISOString() }, current?.revision ?? null);
}
const api = createWorkspaceRepositoryCreationUseCases({ policies, creations,
  authorize: async (_project, email) => { if (email !== owner) throw new ForbiddenError("Workspace access denied"); },
  forge: () => ({ createRepository }), now: () => now });

beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(now); fake.rows.clear();
  createRepository.mockReset().mockImplementation(async request => created(request));
  deployment = { projectName: "demo", mode: "new", repositories: ["company/existing"], runtimes: ["codex"], checks: [], deploymentWorkflows: [] };
  fake.seed([{ ...keys.project("demo"), entityType: "PROJECT", name: "demo", projectType: "agent", displayName: "Demo", description: "", ownerEmail: owner, createdAt: now.toISOString(), updatedAt: now.toISOString() }]);
  await saveSettings();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("server-owned repository creation and automatic access registration", () => {
  it("registers only a successful creation and reuses the receipt without creating twice", async () => {
    expect(workspaceAllowsRepository(deployment, input.repository)).toBe(false);
    expect(await api.create("demo", input, owner)).toMatchObject({ status: "created", allowed: true, reused: false, result: { repositoryId: 42, baseBranch: "main" } });
    expect((await policies.get("demo"))?.rules).toMatchObject({ mode: "new", repositories: ["company/existing", input.repository] });
    expect(await api.create("demo", input, owner)).toMatchObject({ status: "created", allowed: true, reused: true });
    expect(createRepository).toHaveBeenCalledTimes(1);
    expect((await creations.get("demo", input.repository))?.status).toBe("created");
  });

  it("refuses unlisted creation in fixed mode before touching GitHub", async () => {
    deployment.mode = "selected";
    await saveSettings();
    await expect(api.create("demo", input, owner)).rejects.toMatchObject({ status: 400 });
    expect(createRepository).not.toHaveBeenCalled();
    expect(await creations.get("demo", input.repository)).toBeNull();
  });

  it("does not re-add a created repository that an administrator removed while keeping new mode", async () => {
    await api.create("demo", input, owner);
    const current = (await policies.get("demo"))!;
    await policies.put({ ...current, revision: current.revision + 1, rules: { mode: "new", repositories: [] } }, current.revision);
    expect(await api.create("demo", input, owner)).toMatchObject({ status: "created", reused: true, allowed: false });
    expect((await policies.get("demo"))?.rules?.repositories).toEqual([]);
    expect(createRepository).toHaveBeenCalledTimes(1);
  });

  it("permits all-mode creation without making the list an access restriction", async () => {
    deployment.mode = "all"; deployment.repositories = [];
    await saveSettings();
    expect(await api.create("demo", input, owner)).toMatchObject({ status: "created", allowed: true });
    expect(workspaceAllowsRepository(withWorkspaceRepositoryRules(deployment, (await policies.get("demo"))?.rules), "different/existing")).toBe(true);
  });

  it("does not register a repository when GitHub says it already exists", async () => {
    createRepository.mockRejectedValueOnce(new CodingMutationRejectedError("GitHub rejected creation: repository exists"));
    expect(await api.create("demo", input, owner)).toMatchObject({ status: "failed", allowed: false });
    expect((await policies.get("demo"))?.rules?.repositories).toEqual(["company/existing"]);
    expect(workspaceAllowsRepository(deployment, input.repository)).toBe(false);
    expect(await api.create("demo", input, owner)).toMatchObject({ status: "created", allowed: true });
    expect(createRepository).toHaveBeenCalledTimes(2);
  });

  it("never retries an uncertain remote creation or accepts a different request as its result", async () => {
    createRepository.mockRejectedValueOnce(new Error("connection lost"));
    expect(await api.create("demo", input, owner)).toMatchObject({ status: "uncertain", allowed: false });
    await expect(api.create("demo", input, owner)).rejects.toMatchObject({ status: 409 });
    await expect(api.create("demo", { ...input, private: false }, owner)).rejects.toMatchObject({ status: 409 });
    expect(createRepository).toHaveBeenCalledTimes(1);
  });

  it("lets only one concurrent request issue the external create", async () => {
    const results = await Promise.allSettled([api.create("demo", input, owner), api.create("demo", input, owner)]);
    expect(results.some(result => result.status === "fulfilled")).toBe(true);
    expect(createRepository).toHaveBeenCalledTimes(1);
  });

  it("merges concurrent registrations for different names into the latest list", async () => {
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let started = 0;
    createRepository.mockImplementation(async request => { if (++started === 2) release(); await barrier; return created(request); });
    const other = { ...input, repository: "company/second-game" };
    const results = await Promise.all([api.create("demo", input, owner), api.create("demo", other, owner)]);
    expect(results.every(result => result.allowed)).toBe(true);
    expect((await policies.get("demo"))?.rules?.repositories).toEqual(expect.arrayContaining(["company/existing", input.repository, other.repository]));
  });

  it("records creation without granting access when an administrator revokes new mode during the request", async () => {
    createRepository.mockImplementation(async request => {
      await policies.put({ projectName: "demo", revision: 2, updatedAt: now.toISOString(), rules: { mode: "selected", repositories: [] } }, 1);
      return created(request);
    });
    expect(await api.create("demo", input, owner)).toMatchObject({ status: "created", allowed: false, error: expect.stringContaining("current policy") });
    expect((await policies.get("demo"))?.rules).toEqual({ mode: "selected", repositories: [] });
    expect(await api.create("demo", input, owner)).toMatchObject({ reused: true, allowed: false });
    expect(createRepository).toHaveBeenCalledTimes(1);
  });

  it("checks capacity and ownership before creating an external repository", async () => {
    deployment.repositories = Array.from({ length: 100 }, (_, index) => `company/repo-${index}`);
    await saveSettings();
    await expect(api.create("demo", input, owner)).rejects.toMatchObject({ status: 400 });
    await expect(api.create("demo", input, "other@example.test")).rejects.toMatchObject({ status: 403 });
    expect(createRepository).not.toHaveBeenCalled();
  });

  it("counts normalized deployment entries rather than duplicate spellings against capacity", async () => {
    deployment.repositories = Array(100).fill("Company/Existing");
    await saveSettings();
    expect(await api.create("demo", input, owner)).toMatchObject({ status: "created", allowed: true });
    expect((await policies.get("demo"))?.rules?.repositories).toEqual(["company/existing", input.repository]);
  });

  it("retains the pre-call receipt when outcome persistence fails, preventing a replay", async () => {
    vi.spyOn(creations, "finish").mockRejectedValueOnce(new Error("database unavailable"));
    await expect(api.create("demo", input, owner)).rejects.toMatchObject({ status: 502 });
    await expect(api.create("demo", input, owner)).rejects.toMatchObject({ status: 409 });
    expect(createRepository).toHaveBeenCalledTimes(1);
    expect((await creations.get("demo", input.repository))?.status).toBe("creating");
  });

  it("does not recreate policy or receipts after project deletion during a remote create", async () => {
    createRepository.mockImplementation(async request => { await projectRepository.delete("demo"); return created(request); });
    await expect(api.create("demo", input, owner)).rejects.toMatchObject({ status: 502 });
    expect(await policies.get("demo")).toBeNull();
    expect(await creations.get("demo", input.repository)).toBeNull();
  });
});
