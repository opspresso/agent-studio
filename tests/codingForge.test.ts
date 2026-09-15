import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { createCodingGitHub } from "@/infrastructure/github/codingForge";

vi.mock("node:crypto", async importOriginal => ({ ...await importOriginal<typeof import("node:crypto")>(),
  sign: vi.fn(() => Buffer.from("deterministic-test-signature")) }));
const now = new Date("2026-09-14T00:00:00Z");
const sha = "a".repeat(40);
const repository = { repository: "company/repo", baseBranch: "main", branch: "agent/task-1", headSha: sha };
const config = { apiUrl: "http://localhost:9009/api/v3", webUrl: "http://localhost:9009", appId: "app-1", installationId: 42,
  privateKey: "test-private-key", webhookSecret: "test-webhook", internalHosts: ["localhost"] };
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

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  requests = []; existing = false; dispatchCount = 0;
  mainSha = "e".repeat(40); branchSha = sha; comparison = "ahead"; refusal = 0;
  branchNames = ["main", "feature/change"]; repositoryStatus = 200; branchStatus = 200;
  checks = [{ status: "completed", conclusion: "success" }];
  pull = { number: 7, node_id: "PR_node", html_url: "http://localhost:9009/company/repo/pull/7", draft: false, state: "open",
    head: { sha, ref: repository.branch, repo: { full_name: repository.repository } },
    base: { ref: "main", repo: { full_name: repository.repository } } };
  vi.stubGlobal("fetch", vi.fn(async (url: URL, init: RequestInit) => {
    const request = { url: String(url), method: init.method ?? "GET", headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : {} };
    requests.push(request);
    if (request.url.includes("/git/ref/heads/")) return Response.json({ object: { type: "commit", sha: request.url.endsWith("/main") ? mainSha : branchSha } });
    if (request.url.includes("/compare/")) return Response.json({ status: comparison });
    if (request.url.includes("/git/refs/heads/main")) return refusal ? new Response("refused", { status: refusal }) : Response.json({ object: { sha: request.body.sha } });
    if (request.url.endsWith("/access_tokens")) return Response.json({ token: "short-lived-test-token", expires_at: "2026-09-14T01:00:00Z" });
    if (request.url.includes("/branches?")) return Response.json(branchNames.map(name => ({ name })), { status: repositoryStatus });
    if (request.url.includes("/branches/")) return Response.json({}, { status: branchStatus });
    if (request.url.includes("/check-runs?")) return Response.json({ total_count: checks.length, check_runs: checks });
    if (request.url.includes("/status?")) return Response.json({ total_count: 0, state: "pending" });
    if (request.url.includes("/pulls?")) return Response.json(existing ? [pull] : []);
    if (request.url.endsWith("/graphql")) {
      const draft = String(request.body.query).includes("convertPullRequestToDraft");
      return Response.json({ data: { [draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview"]: { pullRequest: { isDraft: draft } } } });
    }
    if (request.url.endsWith("/merge")) return Response.json({ merged: true, sha: "b".repeat(40) });
    if (request.url.endsWith("/dispatches")) { dispatchCount++; return Response.json({ workflow_run_id: 99, html_url: "http://localhost:9009/company/repo/actions/runs/99" }); }
    if (request.url.includes("/pulls")) return Response.json(pull);
    throw new Error("Unexpected test request");
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("coding GitHub App adapter", () => {
  it.each([401, 403, 404])("reports unavailable repository access before clone (%s)", async status => {
    repositoryStatus = status;
    await expect(createCodingGitHub(config, () => now).forge.checkRepository(repository.repository, "main"))
      .rejects.toMatchObject({ reason: "unavailable", message: expect.stringContaining(`HTTP ${status}`) });
    expect(requests.filter(row => !row.url.endsWith("/access_tokens")).every(row => row.method === "GET")).toBe(true);
  });
  it("distinguishes an empty repository from a missing branch and accepts a ready branch", async () => {
    const forge = createCodingGitHub(config, () => now).forge;
    branchNames = [];
    await expect(forge.checkRepository(repository.repository, "main")).rejects.toMatchObject({ reason: "empty" });
    branchNames = ["develop"]; branchStatus = 404;
    await expect(forge.checkRepository(repository.repository, "main")).rejects.toMatchObject({ reason: "branch-missing" });
    branchStatus = 200;
    await expect(forge.checkRepository(repository.repository, "main")).resolves.toBeUndefined();
  });
  it("does not call a transport failure a missing repository", async () => {
    repositoryStatus = 503;
    await expect(createCodingGitHub(config, () => now).forge.checkRepository(repository.repository, "main"))
      .rejects.toMatchObject({ status: 503 });
  });
  it("uses account credentials only on the server and never issues them to a Sandbox", async () => {
    const getToken = vi.fn(async () => "server-only-account-token");
    const github = createCodingGitHub({ apiUrl: config.apiUrl, webUrl: config.webUrl, internalHosts: config.internalHosts, getToken }, () => now);
    expect((await github.forge.branches(repository.repository)).names).toContain("main");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.get("Authorization")).toBe("Bearer server-only-account-token");
    expect(() => github.credential(repository.repository, "read")).toThrow("cannot be issued");
    expect(getToken).toHaveBeenCalledTimes(1);
  });
  it("issues short-lived tokens scoped to the selected repository and exact permission", async () => {
    const github = createCodingGitHub(config, () => now);
    const credential = await github.credential(repository.repository, "read");
    expect(credential.expiresAt).toBe("2026-09-14T01:00:00Z");
    expect(requests[0]?.body).toEqual({ repositories: ["repo"], permissions: { contents: "read" } });
    const jwt = requests[0]!.headers.get("Authorization")!.slice(7).split(".");
    expect(JSON.parse(Buffer.from(jwt[1]!, "base64url").toString())).toMatchObject({ iss: "app-1", iat: now.getTime() / 1000 - 60, exp: now.getTime() / 1000 + 540 });
    expect(JSON.stringify(requests)).not.toContain(config.privateKey);
  });
  it("lists bounded branch choices", async () => {
    expect(await createCodingGitHub(config, () => now).forge.branches(repository.repository)).toEqual({ names: ["main", "feature/change"], hasMore: false });
  });
  it("does not treat absent, pending or failed CI as success", async () => {
    const forge = createCodingGitHub(config, () => now).forge;
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
    const forge = createCodingGitHub(config, () => now).forge;
    expect((await forge.pullRequest(repository, 7)).ci).toBe("none");
    await forge.merge(repository, 7, sha);
    expect(requests.find(request => request.url.endsWith("/merge"))?.body.sha).toBe(sha);
  });
  it("publishes only the reviewed work branch to main with force disabled", async () => {
    const forge = createCodingGitHub(config, () => now).forge;
    expect(await forge.reviewMainPush(repository, sha)).toEqual({ baseSha: mainSha, ci: "passed" });
    expect(await forge.pushMain(repository, sha, mainSha)).toBe(sha);
    expect(requests.find(request => request.method === "PATCH")?.body).toEqual({ sha, force: false });
    expect(requests.some(request => request.url.includes("/pulls"))).toBe(false);
  });
  it.each(["diverged", "behind"])("refuses a %s main update without sending a mutation", async state => {
    comparison = state;
    await expect(createCodingGitHub(config, () => now).forge.reviewMainPush(repository, sha)).rejects.toThrow("never overwrites history");
    expect(requests.some(request => request.method === "PATCH")).toBe(false);
  });
  it("rejects unpublished, changed-base and pending-CI main pushes", async () => {
    const forge = createCodingGitHub(config, () => now).forge;
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
    await expect(createCodingGitHub(config, () => now).forge.pushMain(repository, sha, mainSha)).rejects.toMatchObject({ message: expect.stringContaining("branch rules") });
  });
  it("merges only the exact head and rejects foreign pull requests", async () => {
    const forge = createCodingGitHub(config, () => now).forge;
    await expect(forge.merge(repository, 7, "c".repeat(40))).rejects.toThrow("head");
    await forge.merge(repository, 7, sha);
    expect(requests.find(request => request.url.endsWith("/merge"))?.body).toEqual({ sha, merge_method: "merge" });
    pull.head.ref = "other-branch";
    await expect(forge.pullRequest(repository, 7)).rejects.toThrow("does not belong");
  });
  it("reuses a draft PR and explicitly marks it ready for review", async () => {
    existing = true; pull.draft = true;
    const result = await createCodingGitHub(config, () => now).forge.openPullRequest(repository, { title: "Title", body: "Body", draft: false });
    expect(result.draft).toBe(false);
    expect(requests.filter(request => request.url.endsWith("/pulls") && request.method === "POST")).toHaveLength(0);
    expect(requests.find(request => request.url.endsWith("/graphql"))?.body.variables).toEqual({ id: "PR_node" });
  });
  it("does not edit an existing PR whose source head changed after publication", async () => {
    existing = true; pull.head.sha = "f".repeat(40);
    await expect(createCodingGitHub(config, () => now).forge.openPullRequest(repository, { title: "Title", body: "Body", draft: false })).rejects.toThrow("head changed");
    expect(requests.some(request => request.method === "PATCH")).toBe(false);
  });
  it("dispatches a workflow through GitHub rather than Sandbox execution", async () => {
    const result = await createCodingGitHub(config, () => now).forge.dispatch(repository.repository, "deploy.yaml", "main", { target: "preview" });
    expect(result.runId).toBe(99);
    expect(dispatchCount).toBe(1);
    expect(requests.find(request => request.url.endsWith("/dispatches"))?.body).toEqual({ ref: "main", inputs: { target: "preview" } });
  });
  it("honors an explicit request to convert an existing PR to draft", async () => {
    existing = true;
    const result = await createCodingGitHub(config, () => now).forge.openPullRequest(repository, { title: "Title", body: "Body", draft: true });
    expect(result.draft).toBe(true);
    expect(String(requests.find(request => request.url.endsWith("/graphql"))?.body.query)).toContain("convertPullRequestToDraft");
  });
  it("authenticates webhook bodies, including rejection after body tampering", () => {
    const github = createCodingGitHub(config, () => now);
    const body = '{"event":"check_run"}';
    const signature = `sha256=${createHmac("sha256", config.webhookSecret).update(body).digest("hex")}`;
    expect(github.verifyWebhook(body, signature)).toBe(true);
    expect(github.verifyWebhook(body + " ", signature)).toBe(false);
    expect(github.verifyWebhook(body, null)).toBe(false);
  });
});
