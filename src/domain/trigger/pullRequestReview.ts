import { isRepositoryName } from "@/domain/workspace/policy";

export const MAX_REVIEW_REPOSITORIES = 20;

export type GitHubReviewConfig =
  /** A signed event may target any repository the configured GitHub account can read and review. */
  | { scope: "accessible" }
  | { scope: "repositories"; repositories: string[] };

export interface PullRequestReviewTarget {
  repository: string;
  number: number;
  headSha: string;
}

export interface PullRequestReviewFile {
  path: string;
  previousPath?: string;
  status: string;
  patch?: string;
}

export interface PullRequestReviewContext extends PullRequestReviewTarget {
  title: string;
  body: string;
  url: string;
  files: PullRequestReviewFile[];
  totalFiles: number;
}

export type PullRequestReviewDelivery =
  | { status: "posted"; url: string }
  | { status: "skipped"; reason: string };

/** Credentials and provider URLs belong to the adapter, never the webhook payload or model. */
export interface PullRequestReviewForge {
  load(target: PullRequestReviewTarget): Promise<
    { status: "ready"; context: PullRequestReviewContext } | { status: "skipped"; reason: string }
  >;
  /** Rechecks current HEAD and posts a COMMENT review anchored to target.headSha. */
  reply(target: PullRequestReviewTarget, body: string): Promise<PullRequestReviewDelivery>;
}

export function reviewRepositories(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REVIEW_REPOSITORIES ||
    value.some(name => typeof name !== "string" || !isRepositoryName(name.trim()))) return null;
  return [...new Set(value.map(name => (name as string).trim().toLowerCase()))];
}

export function reviewAllowsRepository(config: GitHubReviewConfig | undefined, repository: string): boolean {
  return isRepositoryName(repository) && (config?.scope === "accessible" ||
    (config?.scope === "repositories" && !!reviewRepositories(config.repositories)?.includes(repository.toLowerCase())));
}

const REVIEW_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Called only after HMAC validation. Repository and PR body text still cannot select a destination. */
export function selectPullRequestReview(
  config: GitHubReviewConfig,
  event: string,
  payload: unknown,
): { status: "ready"; target: PullRequestReviewTarget } | { status: "ignored"; reason: string } {
  const ignore = (reason: string) => ({ status: "ignored" as const, reason });
  if (event !== "pull_request") return ignore("Not a pull_request event.");
  const body = object(payload);
  if (typeof body.action !== "string" || !REVIEW_ACTIONS.has(body.action)) return ignore("This pull request action does not request a review.");
  const repository = object(body.repository).full_name;
  if (typeof repository !== "string" || !reviewAllowsRepository(config, repository)) {
    return ignore("Repository is not allowed for this review trigger.");
  }
  const pull = object(body.pull_request);
  if (pull.state !== "open" || pull.draft !== false) return ignore("Pull request is closed or not ready for review.");
  const baseRepository = object(object(pull.base).repo).full_name;
  if (typeof baseRepository !== "string" || baseRepository.toLowerCase() !== repository.toLowerCase()) {
    return ignore("Pull request base repository does not match the event repository.");
  }
  const number = body.number;
  const headSha = object(pull.head).sha;
  if (!Number.isSafeInteger(number) || (number as number) <= 0 || pull.number !== number ||
    typeof headSha !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(headSha)) return ignore("Pull request identity is invalid.");
  return { status: "ready", target: { repository: repository.toLowerCase(), number: number as number, headSha } };
}
