import type { CodingCiWatch, PullRequestInfo } from "@/domain/coding/types";

const CI_WAIT_MS = 30 * 60 * 1000;

/** Only the exact open PR head starts a bounded, read-only CI continuation. */
export function codingCiWatch(pull: PullRequestInfo | undefined, now: Date): CodingCiWatch | undefined {
  return pull?.state === "open" && pull.ci === "pending"
    ? { number: pull.number, headSha: pull.headSha, deadline: new Date(now.getTime() + CI_WAIT_MS).toISOString() }
    : undefined;
}
