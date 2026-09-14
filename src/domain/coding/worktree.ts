import type { CodingRepository } from "./types";

export interface WorktreeReview {
  headSha: string;
  diff: string;
  truncated: boolean;
  /** Hash of the complete current tree, including untracked files. Never a truncated diff hash. */
  fingerprint: string;
}

/** Git is an optional workspace capability, separate from the compute provider. */
export interface CodingWorktree {
  prepare(externalId: string, repository: CodingRepository): Promise<CodingRepository>;
  review(externalId: string): Promise<WorktreeReview>;
}
