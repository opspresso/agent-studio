import type { CodingRepository, PullRequestInfo } from "./types";
import type { CreateWorkspaceRepositoryInput, CreatedWorkspaceRepository } from "@/domain/workspace/repositoryCreation";

export interface CodingForge {
  createRepository?(input: CreateWorkspaceRepositoryInput): Promise<CreatedWorkspaceRepository>;
  checkRepository(repository: string, baseBranch: string): Promise<void>;
  branches(repository: string): Promise<{ names: string[]; hasMore: boolean }>;
  pullRequest(repository: CodingRepository, number: number): Promise<PullRequestInfo>;
  openPullRequest(repository: CodingRepository, input: { title: string; body: string; draft: boolean }): Promise<PullRequestInfo>;
  merge(repository: CodingRepository, number: number, headSha: string): Promise<string>;
  reviewMainPush(repository: CodingRepository, headSha: string): Promise<{ baseSha: string; ci: PullRequestInfo["ci"] }>;
  pushMain(repository: CodingRepository, headSha: string, baseSha: string): Promise<string>;
  dispatch(repository: string, workflow: string, ref: string, inputs: Record<string, string>): Promise<{ runId?: number; url?: string }>;
}
