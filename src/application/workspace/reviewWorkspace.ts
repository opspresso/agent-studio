import type { McpToolResult } from "@/domain/llm/types";
import type { PullRequestReviewTarget, ReviewWorkspaceSession, ReviewWorkspaceTool } from "@/domain/trigger/pullRequestReview";
import { isTerminalWorkspaceRun, type Workspace, type WorkspaceRun } from "@/domain/workspace/types";
import type { WorktreeReview } from "@/domain/coding/worktree";
import { observeWorkspacePage } from "./output";

interface ReviewWorkspaceDeps {
  tool: ReviewWorkspaceTool;
  state(id: string): Promise<Workspace | null>;
  close(id: string): Promise<void>;
  verify(id: string): Promise<WorktreeReview>;
  sleep(ms: number): Promise<void>;
}

/** The review owns one pinned Sandbox and closes it on both publication and failure. */
export async function openReviewWorkspace(deps: ReviewWorkspaceDeps, target: PullRequestReviewTarget): Promise<ReviewWorkspaceSession> {
  const decode = (result: McpToolResult): Record<string, unknown> => {
    if (result.text.startsWith("Error:")) throw new Error(result.text);
    return JSON.parse(result.text) as Record<string, unknown>;
  };
  const started = decode(await deps.tool({ request: { operation: "start", runtime: "command", repository: null, base_branch: null,
    task: "git rev-parse HEAD" } }, "review-bootstrap"));
  if (typeof started.workspace_id !== "string" || typeof started.workspace_url !== "string") throw new Error("Review Workspace creation returned no identity");
  const id = started.workspace_id;
  const close = async () => {
    await deps.close(id);
    for (let step = 0; step < 120; step++) {
      const workspace = await deps.state(id);
      if (!workspace || workspace.status === "closed") return;
      await deps.sleep(1000);
    }
    throw new Error("Review Workspace did not close before its cleanup deadline");
  };
  try {
    let ready = started;
    for (let step = 0; step < 24 && (ready.status === "queued" || ready.status === "running"); step++) {
      ready = decode(await deps.tool({ request: { operation: "wait", workspace_id: id, run_id: started.run_id } }, "review-bootstrap-wait"));
    }
    if (ready.status !== "succeeded" || ready.head_sha !== target.headSha) throw new Error("Review Workspace could not check out the verified PR commit");
    if (ready.output_loss === true) throw new Error("Review Workspace checkout output was permanently omitted");
    const unfinished = new Set<string>();
    const outputLoss = new Set<string>();
    const readRanges = new Map<string, Array<[number, number]>>();
    const statuses = new Map<string, WorkspaceRun["status"]>();
    const pendingReads = () => [...unfinished].map(runId => {
      const first = readRanges.get(runId)?.[0];
      const status = statuses.get(runId);
      return { operation: status && isTerminalWorkspaceRun(status) ? "status" : "wait",
        workspace_id: id, run_id: runId, after_seq: first?.[0] === 0 ? first[1] : 0 };
    });
    let unconfirmedAdmission = false;
    return {
      id, url: started.workspace_url, close,
      async tool(args, callId) {
        const request = args.request as Record<string, unknown> | undefined;
        if (request?.operation === "start") throw new Error("The review Workspace is already prepared; use run for source reads and checks");
        const startsRun = request?.operation === "run";
        // A lost response can follow a committed enqueue and outlive activeRunId.
        if (startsRun) {
          if (unconfirmedAdmission) throw new Error("Review Workspace check admission was not confirmed; no further commands can be queued");
          if (unfinished.size) throw new Error(`Read the previous Review Workspace results before queuing another command: ${JSON.stringify(pendingReads())}`);
          unconfirmedAdmission = true;
        }
        const result = await deps.tool(args, callId);
        const value = decode(result);
        if (startsRun && (typeof value.run_id !== "string" || !value.run_id)) throw new Error("Review Workspace check admission returned no run identity");
        if (typeof value.run_id === "string") {
          unfinished.add(value.run_id);
          statuses.set(value.run_id, value.status as WorkspaceRun["status"]);
          if (startsRun) unconfirmedAdmission = false;
          if (value.output_loss === true) outputLoss.add(value.run_id);
          const observed = observeWorkspacePage(readRanges.get(value.run_id) ?? [], {
            after: (request?.after_seq ?? 0) as number, next: value.next_seq as number, status: value.status as WorkspaceRun["status"],
            hasMore: value.has_more !== false, truncated: value.truncated !== false, outputLoss: value.output_loss === true,
          });
          readRanges.set(value.run_id, observed.ranges);
          if (observed.complete) unfinished.delete(value.run_id);
        }
        return { ...result, text: JSON.stringify({ ...value, review_pending: pendingReads() }) };
      },
      async ensureIdle() {
        if (unconfirmedAdmission) throw new Error("Review Workspace check admission was not confirmed; no review was published");
        const workspace = await deps.state(id);
        if (!workspace || workspace.status !== "active" || workspace.coding?.sourceRevision !== target.headSha ||
          workspace.coding.repository !== target.repository || workspace.coding.headSha !== target.headSha) throw new Error("Review Workspace no longer matches its verified commit");
        if (outputLoss.size) throw new Error("Review Workspace output was permanently omitted; no review was published");
        if (workspace.activeRunId || unfinished.size) throw new Error(`Review Workspace checks are unfinished or their results were not read; no review was published. Pending reads: ${JSON.stringify(pendingReads())}`);
        const review = await deps.verify(id);
        if (review.headSha !== target.headSha || !/^[a-f0-9]{40,64}$/.test(review.treeSha) || review.treeSha !== review.headTreeSha) {
          throw new Error("Review Workspace source changed; checks must use the verified PR tree and temporary files outside the repository");
        }
      },
    };
  } catch (error) {
    try { await close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "Review Workspace preparation and cleanup failed"); }
    throw error;
  }
}
