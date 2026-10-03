import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createCodingGitHub } from "@/infrastructure/github/codingForge";
import { CodingMutationRejectedError } from "@/domain/coding/types";

const now = new Date("2026-09-14T00:00:00Z");
const sha = "a".repeat(40);
const repository = { repository: "company/repo", baseBranch: "main", branch: "agent/task-1", headSha: sha };
const config = { apiUrl: "http://localhost:9009/api/v3", webUrl: "http://localhost:9009",
  getToken: async () => "caller-token", internalHosts: ["localhost"] };
let requests: { url: string; method: string; headers: Headers; body: Record<string, unknown> }[];
let pull: { number: number; node_id: string; html_url: string; draft: boolean; state: "open" | "closed"; head: { sha: string; ref: string; repo: { full_name: string } }; base: { ref: string; repo: { full_name: string } } };
let checks: { status: string; conclusion: string }[];
let existing: boolean;
let dispatchCount: number;
let mainSha: string;
let branchSha: string;
let comparison: string;
let refusal: number;
let branchNames: string[];
let repositoryStatus: number;
let branchStatus: number;
let mergeReceipt: unknown;
let tagSha: string | undefined;
let tagType: string;
let releaseReceipt: Record<string, unknown>;

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  requests = []; existing = false; dispatchCount = 0;
  mainSha = "e".repeat(40); branchSha = sha; comparison = "ahead"; refusal = 0;
  branchNames = ["main", "feature/change"]; repositoryStatus = 200; branchStatus = 200;
  mergeReceipt = { merged: true, sha: "b".repeat(40) };
  tagSha = undefined; tagType = "commit";
  releaseReceipt = { id: 10, html_url: "http://localhost:9009/company/repo/releases/tag/v1.0.0", tag_name: "v1.0.0",
    name: "First release", body: "Verified changes", draft: false, prerelease: false };
  checks = [{ status: "completed", conclusion: "success" }];
  pull = { number: 7, node_id: "PR_node", html_url: "http://localhost:9009/company/repo/pull/7", draft: false, state: "open",
    head: { sha, ref: repository.branch, repo: { full_name: repository.repository } },
    base: { ref: "main", repo: { full_name: repository.repository } } };
  vi.stubGlobal("fetch", vi.fn(async (url: URL, init: RequestInit) => {
    const request = { url: String(url), method: init.method ?? "GET", headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : {} };
    requests.push(request);
    if (request.url.includes("/git/ref/heads/")) return Response.json({ ref: "refs/heads/main", object: { type: "commit", sha: request.url.endsWith("/main") ? mainSha : branchSha } });
    if (request.url.includes("/git/ref/tags/")) return tagSha ? Response.json({ ref: "refs/tags/v1.0.0", object: { type: tagType, sha: tagSha } }) : new Response(null, { status: 404 });
    if (request.url.includes("/git/tags/")) return Response.json({ object: { type: "commit", sha: mainSha } });
    if (request.url.endsWith("/git/refs")) {
      if (refusal) return new Response(null, { status: refusal });
      tagSha = String(request.body.sha);
      return Response.json({ ref: request.body.ref, object: { type: "commit", sha: tagSha } }, { status: 201 });
    }
    if (request.url.endsWith("/releases")) return refusal ? new Response(null, { status: refusal }) : Response.json(releaseReceipt, { status: 201 });
    if (request.url.includes("/compare/")) return Response.json({ status: comparison });
    if (request.url.includes("/git/refs/heads/main")) return refusal ? new Response("refused", { status: refusal }) : Response.json({ object: { sha: request.body.sha } });
    if (request.url.includes("/branches?")) return Response.json(branchNames.map(name => ({ name })), { status: repositoryStatus });
    if (request.url.includes("/branches/")) return Response.json({}, { status: branchStatus });
    if (request.url.endsWith(`/commits/${sha}`)) return Response.json({ sha });
    if (request.url.includes("/check-runs?")) return Response.json({ total_count: checks.length, check_runs: checks });
    if (request.url.includes("/status?")) return Response.json({ total_count: 0, state: "pending" });
    if (request.url.includes("/pulls?")) return Response.json(existing ? [pull] : []);
    if (request.url.endsWith("/graphql")) {
      const draft = String(request.body.query).includes("convertPullRequestToDraft");
      return Response.json({ data: { [draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview"]: { pullRequest: { isDraft: draft } } } });
    }
    if (request.url.endsWith("/merge")) return Response.json(mergeReceipt);
    if (request.url.endsWith("/dispatches")) { dispatchCount++; return Response.json({ workflow_run_id: 99, html_url: "http://localhost:9009/company/repo/actions/runs/99" }); }
    if (request.url.includes("/pulls")) return Response.json(pull);
    throw new Error("Unexpected test request");
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("coding GitHub adapter", () => {
  it("requires the caller's GitHub grant even when obsolete App credentials are supplied", () => {
    expect(() => createCodingGitHub({ ...config, getToken: undefined,
      appId: "old-app", installationId: 42, privateKey: "unused-key" } as never)).toThrow("Invalid coding GitHub configuration");
    expect(requests).toEqual([]);
  });

  const release = { kind: "release" as const, tag: "v1.0.0", title: "First release", body: "Verified changes", draft: false, prerelease: false };
  it("creates an exact main tag and releases it with the caller's grant", async () => {
    const { forge } = createCodingGitHub(config);
    const target = await forge.releaseTarget(repository);
    expect(target).toEqual({ headSha: mainSha, ci: "passed" });
    expect(await forge.createTag(repository, release.tag, target.headSha)).toBe(mainSha);
    expect(await forge.createRelease(repository, release, target.headSha)).toBe(releaseReceipt.html_url);
    expect(requests.find(row => row.url.endsWith("/git/refs"))?.body).toEqual({ ref: "refs/tags/v1.0.0", sha: mainSha });
    expect(requests.find(row => row.url.endsWith("/releases"))?.body).toEqual({ tag_name: release.tag, target_commitish: mainSha,
      name: release.title, body: release.body, draft: false, prerelease: false });
    expect(requests.every(row => row.headers.get("Authorization") === "Bearer caller-token")).toBe(true);
  });
  it("reuses a matching tag and refuses tag overwrite, stale main and failed checks", async () => {
    const { forge } = createCodingGitHub(config);
    tagSha = mainSha;
    expect(await forge.createTag(repository, release.tag, mainSha)).toBe(mainSha);
    tagSha = sha;
    await expect(forge.createTag(repository, release.tag, mainSha)).rejects.toThrow("never overwritten");
    await expect(forge.createTag(repository, release.tag, sha)).rejects.toThrow("changed since tag approval");
    checks = [{ status: "completed", conclusion: "failure" }];
    await expect(forge.createTag(repository, release.tag, mainSha)).rejects.toThrow("CI changed");
    expect(requests.filter(row => row.url.endsWith("/git/refs"))).toEqual([]);
  });
  it("resolves annotated tags and requires an existing exact tag before release", async () => {
    const { forge } = createCodingGitHub(config);
    await expect(forge.releaseTarget(repository, release.tag)).rejects.toThrow("Create the requested tag");
    tagSha = sha; tagType = "tag";
    expect((await forge.releaseTarget(repository, release.tag)).headSha).toBe(mainSha);
    tagType = "commit";
    await expect(forge.createRelease(repository, release, mainSha)).rejects.toThrow("changed since release approval");
    expect(requests.some(row => row.url.endsWith("/releases"))).toBe(false);
  });
  it.each([403, 422])("classifies HTTP %i as a definitive publication refusal", async status => {
    const { forge } = createCodingGitHub(config);
    refusal = status;
    await expect(forge.createTag(repository, release.tag, mainSha)).rejects.toBeInstanceOf(CodingMutationRejectedError);
    tagSha = mainSha;
    await expect(forge.createRelease(repository, release, mainSha)).rejects.toBeInstanceOf(CodingMutationRejectedError);
  });
  it.each([{ id: 0 }, { tag_name: "other" }, { draft: true }, { html_url: "https://unrelated.test/release" }])("rejects an unconfirmed release receipt %j", async patch => {
    tagSha = mainSha;
    Object.assign(releaseReceipt, patch);
    await expect(createCodingGitHub(config).forge.createRelease(repository, release, mainSha)).rejects.toThrow();
  });
  it("keeps a release outcome uncertain if its tag becomes invalid after creation", async () => {
    tagSha = mainSha;
    const fetch = vi.mocked(globalThis.fetch);
    const original = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (...args) => {
      const response = await original(...args);
      if (String(args[0]).endsWith("/releases")) tagType = "tree";
      return response;
    });
    const result = await createCodingGitHub(config).forge.createRelease(repository, release, mainSha).catch(error => error);
    expect(result).toBeInstanceOf(Error);
    expect(result).not.toBeInstanceOf(CodingMutationRejectedError);
    expect(result.message).toContain("Release was created");
  });
  it("checks the immutable review commit instead of a mutable branch", async () => {
    const { forge } = createCodingGitHub(config);
    await forge.checkRepository(repository.repository, `review/${sha}`, sha);
    expect(requests.some(request => request.url.endsWith(`/commits/${sha}`))).toBe(true);
    expect(requests.some(request => request.url.includes("/branches"))).toBe(false);
    await expect(forge.checkRepository(repository.repository, "main", "../main")).rejects.toThrow("Invalid review commit");
  });
  it.each([401, 403, 404])("reports unavailable repository access before clone (%s)", async status => {
    repositoryStatus = status;
    await expect(createCodingGitHub(config).forge.checkRepository(repository.repository, "main"))
      .rejects.toMatchObject({ reason: "unavailable", message: expect.stringContaining(`HTTP ${status}`) });
    expect(requests.every(row => row.method === "GET")).toBe(true);
  });
  it("distinguishes an empty repository from a missing branch and accepts a ready branch", async () => {
    const forge = createCodingGitHub(config).forge;
    branchNames = [];
    await expect(forge.checkRepository(repository.repository, "main")).rejects.toMatchObject({ reason: "empty" });
    branchNames = ["develop"]; branchStatus = 404;
    await expect(forge.checkRepository(repository.repository, "main")).rejects.toMatchObject({ reason: "branch-missing" });
    branchStatus = 200;
    await expect(forge.checkRepository(repository.repository, "main")).resolves.toBeUndefined();
  });
  it("does not call a transport failure a missing repository", async () => {
    repositoryStatus = 503;
    await expect(createCodingGitHub(config).forge.checkRepository(repository.repository, "main"))
      .rejects.toMatchObject({ status: 503 });
  });
  it("uses the caller's account credential at the server request boundary", async () => {
    const getToken = vi.fn(async () => "server-only-account-token");
    const github = createCodingGitHub({ apiUrl: config.apiUrl, webUrl: config.webUrl, internalHosts: config.internalHosts, getToken });
    expect((await github.forge.branches(repository.repository)).names).toContain("main");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.get("Authorization")).toBe("Bearer server-only-account-token");
    expect(getToken).toHaveBeenCalledTimes(1);
  });
  it("reads the current grant on every operation and stops when it is revoked", async () => {
    const getToken = vi.fn().mockResolvedValueOnce("first-token").mockResolvedValueOnce("rotated-token").mockRejectedValueOnce(new Error("grant revoked"));
    const github = createCodingGitHub({ ...config, getToken });
    await github.forge.branches(repository.repository);
    await github.forge.branches(repository.repository);
    await expect(github.forge.branches(repository.repository)).rejects.toThrow("grant revoked");
    expect(requests.map(row => row.headers.get("Authorization"))).toEqual(["Bearer first-token", "Bearer rotated-token"]);
  });
  it("lists bounded branch choices", async () => {
    expect(await createCodingGitHub(config).forge.branches(repository.repository)).toEqual({ names: ["main", "feature/change"], hasMore: false });
  });
  it("does not treat absent, pending or failed CI as success", async () => {
    const forge = createCodingGitHub(config).forge;
    checks = [];
    expect((await forge.pullRequest(repository, 7)).ci).toBe("none");
    checks = [{ status: "in_progress", conclusion: "" }];
    expect((await forge.pullRequest(repository, 7)).ci).toBe("pending");
    checks = [{ status: "completed", conclusion: "failure" }];
    await expect(forge.merge(repository, 7, sha)).rejects.toThrow("CI changed");
    expect(requests.some(request => request.method === "PUT")).toBe(false);
  });
  it("merges a PR with no reported checks without claiming CI passed", async () => {
    checks = [];
    const forge = createCodingGitHub(config).forge;
    expect((await forge.pullRequest(repository, 7)).ci).toBe("none");
    await forge.merge(repository, 7, sha);
    expect(requests.find(request => request.url.endsWith("/merge"))?.body.sha).toBe(sha);
  });
  it("publishes only the reviewed work branch to main with force disabled", async () => {
    const forge = createCodingGitHub(config).forge;
    expect(await forge.reviewMainPush(repository, sha)).toEqual({ baseSha: mainSha, ci: "passed" });
    expect(await forge.pushMain(repository, sha, mainSha)).toBe(sha);
    expect(requests.find(request => request.method === "PATCH")?.body).toEqual({ sha, force: false });
    expect(requests.some(request => request.url.includes("/pulls"))).toBe(false);
  });
  it.each(["diverged", "behind"])("refuses a %s main update without sending a mutation", async state => {
    comparison = state;
    await expect(createCodingGitHub(config).forge.reviewMainPush(repository, sha)).rejects.toThrow("never overwrites history");
    expect(requests.some(request => request.method === "PATCH")).toBe(false);
  });
  it("rejects unpublished, changed-base and pending-CI main pushes", async () => {
    const forge = createCodingGitHub(config).forge;
    branchSha = "f".repeat(40);
    await expect(forge.reviewMainPush(repository, sha)).rejects.toThrow("Push the reviewed commit");
    branchSha = sha;
    await expect(forge.pushMain(repository, sha, "f".repeat(40))).rejects.toThrow("Main head or CI changed");
    checks = [{ status: "queued", conclusion: "" }];
    await expect(forge.pushMain(repository, sha, mainSha)).rejects.toThrow("Main head or CI changed");
    expect(requests.some(request => request.method === "PATCH")).toBe(false);
  });
  it("distinguishes GitHub's definitive branch-rule refusal from a lost response", async () => {
    refusal = 422;
    await expect(createCodingGitHub(config).forge.pushMain(repository, sha, mainSha)).rejects.toMatchObject({ message: expect.stringContaining("branch rules") });
  });
  it("merges only the exact head and rejects foreign pull requests", async () => {
    const forge = createCodingGitHub(config).forge;
    await expect(forge.merge(repository, 7, "c".repeat(40))).rejects.toThrow("head");
    await forge.merge(repository, 7, sha);
    expect(requests.find(request => request.url.endsWith("/merge"))?.body).toEqual({ sha, merge_method: "merge" });
    pull.head.ref = "other-branch";
    await expect(forge.pullRequest(repository, 7)).rejects.toThrow("does not belong");
  });
  it.each([
    { merged: true }, { merged: true, sha: "" }, { merged: true, sha: "not-a-commit" },
    { merged: true, sha: "b".repeat(41) }, { merged: "true", sha }, { merged: 1, sha },
  ])("keeps an invalid merge receipt uncertain (%j)", async receipt => {
    mergeReceipt = receipt;
    await expect(createCodingGitHub(config).forge.merge(repository, 7, sha))
      .rejects.toThrow("did not confirm the pull request merge");
    expect(requests.filter(request => request.url.endsWith("/merge"))).toHaveLength(1);
  });
  it("distinguishes a confirmed merge refusal from an invalid receipt", async () => {
    mergeReceipt = { merged: false, sha: "" };
    await expect(createCodingGitHub(config).forge.merge(repository, 7, sha))
      .rejects.toBeInstanceOf(CodingMutationRejectedError);
  });
  it.each([40, 64])("returns a confirmed %i-character merge commit", async length => {
    mergeReceipt = { merged: true, sha: "b".repeat(length) };
    await expect(createCodingGitHub(config).forge.merge(repository, 7, sha))
      .resolves.toBe("b".repeat(length));
  });
  it("reuses a draft PR and explicitly marks it ready for review", async () => {
    existing = true; pull.draft = true;
    const result = await createCodingGitHub(config).forge.openPullRequest(repository, { title: "Title", body: "Body", draft: false });
    expect(result.draft).toBe(false);
    expect(requests.filter(request => request.url.endsWith("/pulls") && request.method === "POST")).toHaveLength(0);
    expect(requests.find(request => request.url.endsWith("/graphql"))?.body.variables).toEqual({ id: "PR_node" });
  });
  it("does not edit an existing PR whose source head changed after publication", async () => {
    existing = true; pull.head.sha = "f".repeat(40);
    await expect(createCodingGitHub(config).forge.openPullRequest(repository, { title: "Title", body: "Body", draft: false })).rejects.toThrow("head changed");
    expect(requests.some(request => request.method === "PATCH")).toBe(false);
  });
  it("dispatches a workflow through GitHub rather than Sandbox execution", async () => {
    const result = await createCodingGitHub(config).forge.dispatch(repository.repository, "deploy.yaml", "main", { target: "preview" });
    expect(result.runId).toBe(99);
    expect(dispatchCount).toBe(1);
    expect(requests.find(request => request.url.endsWith("/dispatches"))?.body).toEqual({ ref: "main", inputs: { target: "preview" } });
  });
  it("honors an explicit request to convert an existing PR to draft", async () => {
    existing = true;
    const result = await createCodingGitHub(config).forge.openPullRequest(repository, { title: "Title", body: "Body", draft: true });
    expect(result.draft).toBe(true);
    expect(String(requests.find(request => request.url.endsWith("/graphql"))?.body.query)).toContain("convertPullRequestToDraft");
  });
});
