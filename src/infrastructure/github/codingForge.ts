import { createHmac, sign } from "node:crypto";
import type { CodingForge } from "@/domain/coding/forge";
import type { CodingRepository, PullRequestInfo } from "@/domain/coding/types";
import { GITHUB_PAGE_SIZE } from "@/domain/coding/limits";
import { isRepositoryName } from "@/domain/workspace/policy";
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
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("..")) throw new Error("Invalid GitHub API path");
    const url = graphql ? `${base.replace(/\/api\/v3$/, "/api")}/graphql` : `${base}${path}`;
    const internal = isDeclaredInternalHost(url, config.internalHosts);
    if (!internal) await resolvePublicUrl(url);
    const response = await (internal ? fetchSameOrigin : fetchPublicUrl)(url, {
      method, headers: { ...githubHeaders(token), ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`GitHub ${method} request failed (${response.status})`);
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
  async function view(repository: CodingRepository, pull: Pull, accessToken: string): Promise<PullRequestInfo> {
    if (pull.head.repo.full_name.toLowerCase() !== repository.repository.toLowerCase() ||
      pull.base.repo.full_name.toLowerCase() !== repository.repository.toLowerCase() || pull.head.ref !== repository.branch ||
      pull.base.ref !== repository.baseBranch || !/^[a-f0-9]{40,64}$/.test(pull.head.sha) || new URL(pull.html_url).origin !== web.origin) {
      throw new Error("Pull request does not belong to this workspace");
    }
    const path = repoPath(repository.repository);
    const [checks, statuses] = await Promise.all([
      request<{ total_count: number; check_runs: { status: string; conclusion: string | null }[] }>(`${path}/commits/${pull.head.sha}/check-runs?per_page=${GITHUB_PAGE_SIZE}`, accessToken),
      request<{ total_count: number; state: string }>(`${path}/commits/${pull.head.sha}/status?per_page=${GITHUB_PAGE_SIZE}`, accessToken),
    ]);
    const all = checks.check_runs;
    const bounded = checks.total_count <= GITHUB_PAGE_SIZE && statuses.total_count <= GITHUB_PAGE_SIZE && all.length === checks.total_count;
    const failing = all.some(check => check.status === "completed" && !["success", "neutral", "skipped"].includes(check.conclusion ?? "")) ||
      (statuses.total_count > 0 && ["failure", "error"].includes(statuses.state));
    const complete = bounded && all.every(check => check.status === "completed" && ["success", "neutral", "skipped"].includes(check.conclusion ?? "")) &&
      (statuses.total_count === 0 || statuses.state === "success") && (all.some(check => check.conclusion === "success") || statuses.total_count > 0);
    return { number: pull.number, url: pull.html_url, headSha: pull.head.sha, baseBranch: pull.base.ref, draft: pull.draft,
      state: pull.merged ? "merged" : pull.state, ci: failing ? "failed" : complete ? "passed" : "pending" };
  }
  const readPermissions: Permissions = { contents: "read", pull_requests: "read", checks: "read", statuses: "read" };
  const forge: CodingForge = {
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
      return view(repository, pull, access.token);
    },
    async merge(repository, number, headSha) {
      if (repository.baseBranch !== "main") throw new Error("Main merge requires a pull request targeting main");
      const current = await forge.pullRequest(repository, number);
      if (current.headSha !== headSha || current.state !== "open" || current.draft || current.ci !== "passed") throw new Error("Pull request head or CI changed since approval");
      const access = await token(repository.repository, { contents: "write" });
      const result = await request<{ merged: boolean; sha: string }>(`${repoPath(repository.repository)}/pulls/${number}/merge`, access.token, "PUT", { sha: headSha, merge_method: "merge" });
      if (!result.merged) throw new Error("GitHub refused to merge the pull request");
      return result.sha;
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
