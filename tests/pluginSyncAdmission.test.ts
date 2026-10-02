import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ARCHIVE_BRANCH, type PluginsRepoSnapshot } from "@/domain/plugin/sync";
import { PLUGIN_MANIFEST_SCHEMA } from "@/domain/plugin/types";
import type { FakeStore } from "./fakeStore";
import { pluginSyncLock, pluginSyncReportRepository } from "@/infrastructure/db/repositories/pluginSyncRepository";
import { skillRepository } from "@/infrastructure/db/repositories/skillRepository";
import { keys } from "@/infrastructure/db/keys";

const fixture = vi.hoisted(() => ({ sequence: 0, fetchSnapshot: vi.fn(), archiveSnapshot: vi.fn() }));
vi.mock("node:crypto", async original => ({
  ...await original<typeof import("node:crypto")>(),
  randomUUID: () => `00000000-0000-4000-8000-${String(++fixture.sequence).padStart(12, "0")}`,
}));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/infrastructure/db/store", async () => (await import("./fakeStore")).createFakeStore());
vi.mock("@/infrastructure/github/pluginsRepoClient", () => ({ fetchPluginsRepoSnapshot: fixture.fetchSnapshot }));
vi.mock("@/infrastructure/plugin/archiveSnapshot", () => ({
  snapshotFromArchive: fixture.archiveSnapshot,
  TarArchiveError: class extends Error {},
}));
const store = await import("@/infrastructure/db/store") as unknown as FakeStore;
const REPO = "opspresso/agent-plugins";
const repoConfig = { repo: REPO, branch: "main", token: "synthetic-token" };

function snapshot(content: string, commitSha: string, branch = "main"): PluginsRepoSnapshot {
  return { repo: REPO, branch, commitSha, nestedRoots: [], plugins: [{
    rootPath: "", manifestRaw: JSON.stringify({ $schema: PLUGIN_MANIFEST_SCHEMA, name: "review-tools" }),
    skills: [{ name: "review", path: "skills/review/SKILL.md", files: [],
      content: `---\nname: review\ndescription: Review guidance\n---\n\n${content}` }],
    mcpDocs: [], skippedAttachments: [], badSkillDirs: [],
  }] };
}

beforeEach(() => {
  fixture.sequence = 0;
  store.rows.clear();
  vi.useFakeTimers();
  vi.setSystemTime("2026-10-02T06:30:00.000Z");
  vi.stubEnv("S3_BUCKET_NAME", undefined);
  vi.stubEnv("CATALOG_ENABLED", "false");
  vi.stubEnv("MANAGED_MCP_RUNTIME", undefined);
  vi.stubEnv("MANAGED_MCP_REGISTRY", undefined);
  fixture.fetchSnapshot.mockReset().mockResolvedValue(snapshot("Remote guidance", "a".repeat(40)));
  fixture.archiveSnapshot.mockReset().mockResolvedValue(snapshot("Uploaded guidance", "b".repeat(64), ARCHIVE_BRANCH));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("serialized automatic plugin sync admission", () => {
  it("preserves an archive uploaded after a tick's initial report read and before its lease acquisition", async () => {
    const { lastPluginSync, syncPluginsFromRepo, syncPluginsFromArchive } = await import("@/lib/container");
    await syncPluginsFromRepo(repoConfig, "admin@example.test");
    const tickReport = await lastPluginSync(REPO);
    expect(tickReport?.report.commitSha).toBe("a".repeat(40));

    const acquire = pluginSyncLock.acquire.bind(pluginSyncLock);
    vi.spyOn(pluginSyncLock, "acquire").mockImplementationOnce(async (repo, leaseMs) => {
      await syncPluginsFromArchive(new Uint8Array([1]), REPO, "admin@example.test");
      return acquire(repo, leaseMs);
    });
    const getReport = pluginSyncReportRepository.get.bind(pluginSyncReportRepository);
    vi.spyOn(pluginSyncReportRepository, "get").mockImplementationOnce(async repo => {
      expect(await store.getItem(keys.pluginSyncLock(repo))).not.toBeNull();
      return getReport(repo);
    });

    await expect(syncPluginsFromRepo(repoConfig, "scheduler", undefined, { automatic: true }))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining("uploaded archive") });
    expect(fixture.fetchSnapshot).toHaveBeenCalledTimes(1);
    expect((await skillRepository.get("review"))?.content).toContain("Uploaded guidance");
    expect((await lastPluginSync(REPO))?.report.commitSha).toBe("b".repeat(64));
    expect(await store.getItem(keys.pluginSyncLock(REPO))).toBeNull();
  });

  it("allows an explicit manual sync to take over an uploaded archive", async () => {
    const { syncPluginsFromRepo, syncPluginsFromArchive, lastPluginSync } = await import("@/lib/container");
    await syncPluginsFromArchive(new Uint8Array([1]), REPO, "admin@example.test");
    await syncPluginsFromRepo(repoConfig, "admin@example.test");
    expect((await skillRepository.get("review"))?.content).toContain("Remote guidance");
    expect((await lastPluginSync(REPO))?.report.commitSha).toBe("a".repeat(40));
  });

  it("refuses automatic mutation when the report cannot be rechecked under the lease", async () => {
    const { syncPluginsFromRepo } = await import("@/lib/container");
    const failure = new Error("Report store unavailable");
    vi.spyOn(pluginSyncReportRepository, "get").mockRejectedValueOnce(failure);
    await expect(syncPluginsFromRepo(repoConfig, "scheduler", undefined, { automatic: true })).rejects.toBe(failure);
    expect(fixture.fetchSnapshot).not.toHaveBeenCalled();
    expect(await skillRepository.get("review")).toBeNull();
    expect(await store.getItem(keys.pluginSyncLock(REPO))).toBeNull();
  });

  it("allows automatic sync when there is no uploaded archive", async () => {
    const { syncPluginsFromRepo, lastPluginSync } = await import("@/lib/container");
    await syncPluginsFromRepo(repoConfig, "scheduler", undefined, { automatic: true });
    expect((await skillRepository.get("review"))?.content).toContain("Remote guidance");
    expect((await lastPluginSync(REPO))?.actorEmail).toBe("scheduler");
    expect(await store.getItem(keys.pluginSyncLock(REPO))).toBeNull();
  });

  it("rejects a stale owner after its snapshot resumes behind a newer archive upload", async () => {
    const { syncPluginsFromRepo, syncPluginsFromArchive, lastPluginSync } = await import("@/lib/container");
    fixture.fetchSnapshot.mockImplementationOnce(async () => {
      const lock = await store.getItem(keys.pluginSyncLock(REPO));
      vi.setSystemTime(Number(lock!.leaseUntil) + 1);
      await syncPluginsFromArchive(new Uint8Array([1]), REPO, "admin@example.test");
      return snapshot("Stale remote guidance", "a".repeat(40));
    });
    await expect(syncPluginsFromRepo(repoConfig, "scheduler", undefined, { automatic: true })).rejects.toBeInstanceOf(Error);
    expect((await skillRepository.get("review"))?.content).toContain("Uploaded guidance");
    expect((await lastPluginSync(REPO))?.report.commitSha).toBe("b".repeat(64));
    expect(await store.getItem(keys.pluginSyncLock(REPO))).toBeNull();
  });

  it("fences a skill write stalled after admission until a new archive sync has completed", async () => {
    const { syncPluginsFromRepo, syncPluginsFromArchive, lastPluginSync } = await import("@/lib/container");
    const putSkill = skillRepository.put.bind(skillRepository);
    vi.spyOn(skillRepository, "put").mockImplementationOnce(async skill => {
      const lock = await store.getItem(keys.pluginSyncLock(REPO));
      vi.setSystemTime(Number(lock!.leaseUntil) + 1);
      await syncPluginsFromArchive(new Uint8Array([1]), REPO, "admin@example.test");
      return putSkill(skill);
    });
    await expect(syncPluginsFromRepo(repoConfig, "scheduler", undefined, { automatic: true })).rejects.toBeInstanceOf(Error);
    expect((await skillRepository.get("review"))?.content).toContain("Uploaded guidance");
    expect((await lastPluginSync(REPO))?.report.commitSha).toBe("b".repeat(64));
    expect(await store.getItem(keys.pluginSyncLock(REPO))).toBeNull();
  });

  it("fences stale report publication after a newer archive sync has completed", async () => {
    const { syncPluginsFromRepo, syncPluginsFromArchive, lastPluginSync } = await import("@/lib/container");
    const putReport = pluginSyncReportRepository.put.bind(pluginSyncReportRepository);
    vi.spyOn(pluginSyncReportRepository, "put").mockImplementationOnce(async report => {
      const lock = await store.getItem(keys.pluginSyncLock(REPO));
      vi.setSystemTime(Number(lock!.leaseUntil) + 1);
      await syncPluginsFromArchive(new Uint8Array([1]), REPO, "admin@example.test");
      return putReport(report);
    });
    await expect(syncPluginsFromRepo(repoConfig, "scheduler", undefined, { automatic: true })).rejects.toBeInstanceOf(Error);
    expect((await skillRepository.get("review"))?.content).toContain("Uploaded guidance");
    expect((await lastPluginSync(REPO))?.report.commitSha).toBe("b".repeat(64));
    expect(await store.getItem(keys.pluginSyncLock(REPO))).toBeNull();
  });

  it("renews a valid sync through a snapshot load longer than its initial lease", async () => {
    const { syncPluginsFromRepo, lastPluginSync } = await import("@/lib/container");
    fixture.fetchSnapshot.mockImplementationOnce(async () => {
      for (let minute = 0; minute < 9; minute++) await vi.advanceTimersByTimeAsync(60_000);
      return snapshot("Long-running remote guidance", "a".repeat(40));
    });
    await syncPluginsFromRepo(repoConfig, "scheduler", undefined, { automatic: true });
    expect((await skillRepository.get("review"))?.content).toContain("Long-running remote guidance");
    expect((await lastPluginSync(REPO))?.actorEmail).toBe("scheduler");
    expect(await store.getItem(keys.pluginSyncLock(REPO))).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
