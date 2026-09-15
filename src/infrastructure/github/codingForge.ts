import { createHmac, sign } from "node:crypto";
import type { CodingForge } from "@/domain/coding/forge";
import type { CodingRepository, PullRequestInfo } from "@/domain/coding/types";
import { codingCiAllowsPublication, CodingMutationRejectedError, CodingRepositoryNotReadyError } from "@/domain/coding/types";
import { GITHUB_PAGE_SIZE } from "@/domain/coding/limits";
import { isRepositoryName, isGitBranch } from "@/domain/workspace/policy";
import { isDeclaredInternalHost } from "@/domain/security/internalHosts";
import { fetchPublicUrl } from "@/infrastructure/net/publicFetch";
import { fetchSameOrigin } from "@/infrastructure/net/redirectPolicy";
import { resolvePublicUrl } from "@/infrastructure/net/ssrfGuard";
import { readBodyText } from "@/shared/httpBody";
import { timingSafeEqualString } from "@/shared/timingSafe";
import { githubHeaders, GITHUB_TIMEOUT_MS } from "./client";

export interface CodingGitHubConfig {
  apiUrl: string;
  webUrl: string;
  appId?: string;
  installationId?: number;
  privateKey?: string;
  /** Account credentials are used only in the server, including Git bundle transport. */
  getToken?: () => Promise<string>;
  webhookSecret?: string;
  internalHosts: string[];
}

interface Pull {
  number: number; node_id: string; html_url: string; draft: boolean; state: "open" | "closed";
  merged?: boolean; merge_commit_sha?: string;
  head: { sha: string; ref: string; repo: { full_name: string } };
  base: { ref: string; repo: { full_name: string } };
}
type Permissions = Record<string, "read" | "write">;
class GitHubReadError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** App private keys and publication credentials remain in the control plane. */
export function createCodingGitHub(config: CodingGitHubConfig, now = () => new Date()): {
  forge: CodingForge;
  credential(repository: string, access: "read" | "write"): Promise<{ token: string; expiresAt: string }>;
  verifyWebhook(body: string, signature: string | null): boolean;
} {
  const api = new URL(config.apiUrl);
  const web = new URL(config.webUrl);
  if (![api, web].every(url => ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash) ||
    (!config.getToken && (!config.appId || !Number.isSafeInteger(config.installationId) || !config.installationId || config.installationId < 1 || !config.privateKey))) throw new Error("Invalid coding GitHub configuration");
  if ([api, web].some(url => url.protocol !== "https:" && !isDeclaredInternalHost(url.href, config.internalHosts))) throw new Error("Public GitHub endpoints require HTTPS");
  const base = config.apiUrl.replace(/\/+$/, "");
  async function request<T>(path: string, token: string, method = "GET", body?: unknown, graphql = false): Promise<T> {
    if (!path.startsWith("/") || path.startsWith("//") || path.split("?")[0]!.split("/").some(segment => [".", ".."].includes(decodeURIComponent(segment)))) throw new Error("Invalid GitHub API path");
    const url = graphql ? `${base.replace(/\/api\/v3$/, "/api")}/graphql` : `${base}${path}`;
    const internal = isDeclaredInternalHost(url, config.internalHosts);
    if (!internal) await resolvePublicUrl(url);
    const response = await (internal ? fetchSameOrigin : fetchPublicUrl)(url, {
      method, headers: { ...githubHeaders(token), ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const hint = response.status === 403 ? "Check repository permissions and branch protection rules" :
        response.status === 404 ? "Repository, branch or pull request is missing or inaccessible" :
        [405, 409, 422].includes(response.status) ? "GitHub rejected the change; check branch rules, conflicts and the current head" : "Request was not successful";
      const ErrorType = method !== "GET" && response.status >= 400 && response.status < 500 && response.status !== 408 ? CodingMutationRejectedError : Error;
      const message = `GitHub ${method} request failed (${response.status}). ${hint}`;
      if (method === "GET") throw new GitHubReadError(response.status, message);
      throw new ErrorType(message);
    }
    if (response.status === 204) return undefined as T;
    return JSON.parse(await readBodyText(response, 2 * 1024 * 1024)) as T;
  }
  async function token(repository: string, permissions: Permissions) {
    if (!isRepositoryName(repository)) throw new Error("Invalid coding repository");
    if (config.getToken) {
      const value = await config.getToken();
      if (!value || /[\r\n]/.test(value)) throw new Error("Workspace GitHub account token is not configured");
      return { token: value, expiresAt: "" };
    }
    const seconds = Math.floor(now().getTime() / 1000);
    const head = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: config.appId })).toString("base64url");
    let signature: string;
    try { signature = sign("RSA-SHA256", Buffer.from(`${head}.${payload}`), config.privateKey!).toString("base64url"); }
    catch { throw new Error("Invalid GitHub App signing key"); }
    const result = await request<{ token: string; expires_at: string }>(`/app/installations/${config.installationId}/access_tokens`,
      `${head}.${payload}.${signature}`, "POST", { repositories: [repository.split("/")[1]], permissions });
    if (typeof result.token !== "string" || !result.token || !Number.isFinite(Date.parse(result.expires_at)) ||
      Date.parse(result.expires_at) <= now().getTime() || Date.parse(result.expires_at) > now().getTime() + 3_700_000) throw new Error("GitHub returned invalid short-lived credentials");
    return { token: result.token, expiresAt: result.expires_at };
  }
  const repoPath = (repository: string) => {
    if (!isRepositoryName(repository)) throw new Error("Invalid coding repository");
    return `/repos/${repository}`;
  };
  async function ci(repository: string, headSha: string, accessToken: string): Promise<PullRequestInfo["ci"]> {
    const path = repoPath(repository);
    const [checks, statuses] = await Promise.all([
      request<{ total_count: number; check_runs: { status: string; conclusion: string | null }[] }>(`${path}/commits/${headSha}/check-runs?per_page=${GITHUB_PAGE_SIZE}`, accessToken),
      request<{ total_count: number; state: string }>(`${path}/commits/${headSha}/status?per_page=${GITHUB_PAGE_SIZE}`, accessToken),
    ]);
    const all = checks.check_runs;
    const bounded = [checks.total_count, statuses.total_count].every(count => Number.isSafeInteger(count) && count >= 0 && count <= GITHUB_PAGE_SIZE) && all.length === checks.total_count;
    const failing = all.some(check => check.status === "completed" && !["success", "neutral", "skipped"].includes(check.conclusion ?? "")) ||
      (statuses.total_count > 0 && ["failure", "error"].includes(statuses.state));
    const complete = bounded && all.every(check => check.status === "completed" && ["success", "neutral", "skipped"].includes(check.conclusion ?? "")) &&
      (statuses.total_count === 0 || statuses.state === "success") && (all.length > 0 || statuses.total_count > 0);
    return failing ? "failed" : complete ? "passed" : bounded && !all.length && !statuses.total_count ? "none" : "pending";
  }
  async function view(repository: CodingRepository, pull: Pull, accessToken: string): Promise<PullRequestInfo> {
    if (pull.head.repo.full_name.toLowerCase() !== repository.repository.toLowerCase() ||
      pull.base.repo.full_name.toLowerCase() !== repository.repository.toLowerCase() || pull.head.ref !== repository.branch ||
      pull.base.ref !== repository.baseBranch || !/^[a-f0-9]{40,64}$/.test(pull.head.sha) || new URL(pull.html_url).origin !== web.origin) {
      throw new Error("Pull request does not belong to this workspace");
    }
    return { number: pull.number, url: pull.html_url, headSha: pull.head.sha, baseBranch: pull.base.ref, draft: pull.draft,
      state: pull.merged ? "merged" : pull.state, ci: await ci(repository.repository, pull.head.sha, accessToken) };
  }
  const readPermissions: Permissions = { contents: "read", pull_requests: "read", checks: "read", statuses: "read" };
  const forge: CodingForge = {
    async checkRepository(repository, baseBranch) {
      if (!isGitBranch(baseBranch)) throw new Error("Invalid Git base branch");
      const access = await token(repository, { contents: "read" });
      const path = repoPath(repository);
      let branches: { name: string }[];
      try { branches = await request<{ name: string }[]>(`${path}/branches?per_page=1`, access.token); }
      catch (error) {
        if (error instanceof GitHubReadError && [401, 403, 404].includes(error.status)) {
          throw new CodingRepositoryNotReadyError("unavailable", `Repository ${repository} is missing or inaccessible to the Workspace GitHub account (HTTP ${error.status}). The allowlist does not create repositories. Check repository access; if the user requested a new repository, create and initialize it before starting Workspace work.`);
        }
        throw error;
      }
      if (!branches.length) throw new CodingRepositoryNotReadyError("empty", `Repository ${repository} has no commits or branches. Initialize it with a README when creating it, then select its actual base branch before starting Workspace work.`);
      if (branches[0]!.name === baseBranch) return;
      try { await request(`${path}/branches/${encodeURIComponent(baseBranch)}`, access.token); }
      catch (error) {
        if (error instanceof GitHubReadError && error.status === 404) throw new CodingRepositoryNotReadyError("branch-missing", `Repository ${repository} has no branch ${baseBranch}. Select an existing base branch before starting Workspace work.`);
        throw error;
      }
    },
    async branches(repository) {
      const access = await token(repository, { contents: "read" });
      const rows = await request<{ name: string }[]>(`${repoPath(repository)}/branches?per_page=${GITHUB_PAGE_SIZE}`, access.token);
      return { names: rows.map(row => row.name), hasMore: rows.length === GITHUB_PAGE_SIZE };
    },
    async pullRequest(repository, number) {
      const access = await token(repository.repository, readPermissions);
      const pull = await request<Pull>(`${repoPath(repository.repository)}/pulls/${number}`, access.token);
      return view(repository, pull, access.token);
    },
    async openPullRequest(repository, input) {
      const access = await token(repository.repository, { ...readPermissions, pull_requests: "write" });
      const path = repoPath(repository.repository);
      const existing = await request<Pull[]>(`${path}/pulls?state=open&head=${encodeURIComponent(`${repository.repository.split("/")[0]}:${repository.branch}`)}&base=${encodeURIComponent(repository.baseBranch)}&per_page=1`, access.token);
      let pull = existing[0];
      if (!pull) pull = await request<Pull>(`${path}/pulls`, access.token, "POST", { title: input.title, body: input.body, draft: input.draft, head: repository.branch, base: repository.baseBranch });
      else {
        await view(repository, pull, access.token);
        if (repository.headSha && pull.head.sha !== repository.headSha) throw new Error("Pull request head changed since review");
        pull = await request<Pull>(`${path}/pulls/${pull.number}`, access.token, "PATCH", { title: input.title, body: input.body });
        if (pull.draft !== input.draft) {
          const mutation = input.draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview";
          const result = await request<{ errors?: unknown[]; data?: Record<string, { pullRequest?: { isDraft: boolean } }> }>("/graphql", access.token, "POST", {
            query: `mutation($id:ID!){${mutation}(input:{pullRequestId:$id}){pullRequest{isDraft}}}`, variables: { id: pull.node_id },
          }, true);
          if (result.errors?.length || result.data?.[mutation]?.pullRequest?.isDraft !== input.draft) throw new Error("GitHub could not change pull request draft status");
          pull = { ...pull, draft: input.draft };
        }
      }
      if (repository.headSha && pull.head.sha !== repository.headSha) throw new Error("Pull request head changed since review");
      return view(repository, pull, access.token);
    },
    async merge(repository, number, headSha) {
      if (repository.baseBranch !== "main") throw new Error("Main merge requires a pull request targeting main");
      const current = await forge.pullRequest(repository, number);
      if (current.headSha !== headSha || current.state !== "open" || current.draft || !codingCiAllowsPublication(current.ci)) throw new CodingMutationRejectedError("Pull request head or CI changed since approval");
      const access = await token(repository.repository, { contents: "write" });
      const result = await request<{ merged: boolean; sha: string }>(`${repoPath(repository.repository)}/pulls/${number}/merge`, access.token, "PUT", { sha: headSha, merge_method: "merge" });
      if (!result.merged) throw new CodingMutationRejectedError("GitHub refused to merge the pull request");
      return result.sha;
    },
    async reviewMainPush(repository, headSha) {
      if (repository.baseBranch !== "main" || !repository.branch.startsWith("agent/") || !/^[a-f0-9]{40,64}$/.test(headSha)) throw new CodingMutationRejectedError("Main push requires this Workspace's exact published head");
      const access = await token(repository.repository, readPermissions);
      const path = repoPath(repository.repository);
      type Ref = { object: { type: string; sha: string } };
      const [main, branch] = await Promise.all([
        request<Ref>(`${path}/git/ref/heads/main`, access.token),
        request<Ref>(`${path}/git/ref/heads/${encodeURIComponent(repository.branch)}`, access.token),
      ]);
      if (main.object.type !== "commit" || !/^[a-f0-9]{40,64}$/.test(main.object.sha) || branch.object.type !== "commit" || branch.object.sha !== headSha) throw new CodingMutationRejectedError("Push the reviewed commit to the Workspace branch before preparing main push");
      const comparison = await request<{ status: string }>(`${path}/compare/${main.object.sha}...${headSha}?per_page=1`, access.token);
      if (!["ahead", "identical"].includes(comparison.status)) throw new CodingMutationRejectedError("Main has diverged from this branch. Use a reviewed pull request; direct push never overwrites history");
      return { baseSha: main.object.sha, ci: await ci(repository.repository, headSha, access.token) };
    },
    async pushMain(repository, headSha, baseSha) {
      const current = await forge.reviewMainPush(repository, headSha);
      if (current.baseSha !== baseSha || !codingCiAllowsPublication(current.ci)) throw new CodingMutationRejectedError("Main head or CI changed since approval; prepare a new review");
      const access = await token(repository.repository, { contents: "write" });
      const result = await request<{ object: { sha: string } }>(`${repoPath(repository.repository)}/git/refs/heads/main`, access.token, "PATCH", { sha: headSha, force: false });
      if (result.object.sha !== headSha) throw new Error("GitHub did not confirm the reviewed main head");
      return result.object.sha;
    },
    async dispatch(repository, workflow, ref, inputs) {
      const access = await token(repository, { actions: "write" });
      const result = await request<{ workflow_run_id: number; html_url: string } | undefined>(`${repoPath(repository)}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, access.token, "POST", { ref, inputs });
      return result ? { runId: result.workflow_run_id, url: result.html_url } : {};
    },
  };
  return {
    forge,
    credential: (repository, access) => {
      if (config.getToken) throw new Error("Account credentials cannot be issued to a Sandbox");
      return token(repository, { contents: access });
    },
    verifyWebhook: (body, signature) => !!config.webhookSecret && !!signature && timingSafeEqualString(signature,
      `sha256=${createHmac("sha256", config.webhookSecret).update(body).digest("hex")}`),
  };
}
