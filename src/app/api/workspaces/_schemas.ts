import { z } from "zod";
import { WORKSPACE_RUNTIMES } from "@/domain/workspace/types";
import { WORKSPACE_LIMITS } from "@/domain/workspace/limits";
import { isGitBranch, isRepositoryName } from "@/domain/workspace/policy";
import { isSlug } from "@/domain/naming";

export const workspaceInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("task"), prompt: z.string().trim().min(1).max(WORKSPACE_LIMITS.promptChars) }).strict(),
  z.object({ kind: z.literal("command"), script: z.string().min(1).max(WORKSPACE_LIMITS.scriptChars) }).strict(),
]);
export const startWorkspaceSchema = z.object({ projectName: z.string().refine(isSlug), runtime: z.enum(WORKSPACE_RUNTIMES),
  repository: z.string().refine(isRepositoryName).optional(), baseBranch: z.string().refine(isGitBranch).optional(), input: workspaceInputSchema }).strict();
export const codingActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("commit"), message: z.string().trim().min(1).max(8000) }).strict(),
  z.object({ kind: z.literal("commit-and-push"), message: z.string().trim().min(1).max(8000) }).strict(),
  z.object({ kind: z.literal("push") }).strict(),
  z.object({ kind: z.literal("pull-request"), title: z.string().trim().min(1).max(200), body: z.string().max(40_000), draft: z.boolean() }).strict(),
  z.object({ kind: z.literal("merge"), pullRequestNumber: z.number().int().positive(), headSha: z.string().regex(/^[a-f0-9]{40,64}$/) }).strict(),
  z.object({ kind: z.literal("deploy"), workflow: z.string().min(1).max(200), ref: z.literal("main"), inputs: z.record(z.string().regex(/^[\w-]{1,100}$/), z.string().max(4000)) }).strict(),
]);
export const codingDecisionSchema = z.object({ approve: z.boolean() }).strict();
