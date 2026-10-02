import { describe, expect, it, vi } from "vitest";
import { openReviewWorkspace } from "@/application/workspace/reviewWorkspace";
import type { Workspace } from "@/domain/workspace/types";

const target = { repository: "org/repo", number: 130, headSha: "a".repeat(40) };
function fixture(bootstrap = "succeeded") {
  let workspace = { id: "review", status: "active", coding: { repository: target.repository, sourceRevision: target.headSha, headSha: target.headSha } } as Workspace;
  const tool = vi.fn(async (args: Record<string, unknown>) => {
    const request = args.request as { operation: string };
    return { text: JSON.stringify({ workspace_id: workspace.id, workspace_url: "https://studio.example.test/chats/review", run_id: "check",
      status: request.operation === "start" ? "queued" : request.operation === "run" ? "queued" : bootstrap,
      head_sha: target.headSha, next_seq: 0, has_more: false, truncated: false }) };
  });
  const close = vi.fn(async () => { workspace = { ...workspace, status: "closing" }; });
  const sleep = vi.fn(async () => { workspace = { ...workspace, status: "closed" }; });
  const verify = vi.fn(async () => ({ headSha: target.headSha, treeSha: "b".repeat(40), headTreeSha: "b".repeat(40), diff: "", truncated: false, fingerprint: "fixture" }));
  return { deps: { tool, close, sleep, verify, state: async () => workspace }, tool, close, sleep, verify };
}
describe("review Workspace lifecycle", () => {
  it("waits for pinned checkout, requires observed check completion, and waits for actual closure", async () => {
    const f = fixture();
    const session = await openReviewWorkspace(f.deps, target);
    await session.ensureIdle();
    await session.tool({ request: { operation: "run" } }, "check");
    await expect(session.ensureIdle()).rejects.toThrow("unfinished");
    await session.tool({ request: { operation: "wait" } }, "result");
    await session.ensureIdle();
    await session.close();
    expect(f.close).toHaveBeenCalledExactlyOnceWith("review");
    expect(f.sleep).toHaveBeenCalledOnce();
  });
  it("closes a Workspace whose checkout failed without starting review", async () => {
    const f = fixture("failed");
    await expect(openReviewWorkspace(f.deps, target)).rejects.toThrow("could not check out");
    expect(f.close).toHaveBeenCalledOnce();
  });
  it("refuses results from a changed source tree even when HEAD metadata stayed pinned", async () => {
    const f = fixture();
    const session = await openReviewWorkspace(f.deps, target);
    f.verify.mockResolvedValue({ headSha: target.headSha, treeSha: "c".repeat(40), headTreeSha: "b".repeat(40), diff: "changed", truncated: false, fingerprint: "changed" });
    await expect(session.ensureIdle()).rejects.toThrow("source changed");
    await session.close();
    expect(f.close).toHaveBeenCalledOnce();
  });
  it("requires every output page of a terminal check to be delivered without gaps", async () => {
    const f = fixture();
    const session = await openReviewWorkspace(f.deps, target);
    await session.tool({ request: { operation: "run" } }, "check");
    f.tool.mockResolvedValueOnce({ text: JSON.stringify({ run_id: "check", status: "succeeded", next_seq: 21, has_more: false, truncated: false }) });
    await session.tool({ request: { operation: "wait", after_seq: 20 } }, "last-page-first");
    await expect(session.ensureIdle()).rejects.toThrow("results were not read");
    f.tool.mockResolvedValueOnce({ text: JSON.stringify({ run_id: "check", status: "succeeded", next_seq: 20, has_more: true, truncated: false }) });
    await session.tool({ request: { operation: "status", after_seq: 0 } }, "first-page");
    await expect(session.ensureIdle()).rejects.toThrow("results were not read");
    f.tool.mockResolvedValueOnce({ text: JSON.stringify({ run_id: "check", status: "succeeded", next_seq: 21, has_more: false, truncated: false }) });
    await session.tool({ request: { operation: "status", after_seq: 20 } }, "last-page");
    await session.ensureIdle();
  });
  it("does not mark a truncated check result as fully read", async () => {
    const f = fixture();
    const session = await openReviewWorkspace(f.deps, target);
    await session.tool({ request: { operation: "run" } }, "check");
    f.tool.mockResolvedValueOnce({ text: JSON.stringify({ run_id: "check", status: "succeeded", next_seq: 1, has_more: false, truncated: true }) });
    await session.tool({ request: { operation: "wait" } }, "truncated");
    await expect(session.ensureIdle()).rejects.toThrow("results were not read");
  });
  it("directs the model to the first unread page and refuses another command before it is read", async () => {
    const f = fixture();
    const session = await openReviewWorkspace(f.deps, target);
    await session.tool({ request: { operation: "run", task: "read source" } }, "read-source");
    f.tool.mockResolvedValueOnce({ text: JSON.stringify({ run_id: "check", status: "succeeded", next_seq: 20, has_more: true, truncated: false }) });
    const page = JSON.parse((await session.tool({ request: { operation: "wait", run_id: "check" } }, "first-page")).text);
    expect(page.review_pending).toEqual([{ operation: "status", workspace_id: "review", run_id: "check", after_seq: 20 }]);
    const calls = f.tool.mock.calls.length;
    await expect(session.tool({ request: { operation: "run", task: "next check" } }, "next-check")).rejects.toThrow('"after_seq":20');
    expect(f.tool).toHaveBeenCalledTimes(calls);
    await expect(session.ensureIdle()).rejects.toThrow('"run_id":"check"');
    f.tool.mockResolvedValueOnce({ text: JSON.stringify({ run_id: "check", status: "succeeded", next_seq: 24, has_more: false, truncated: false }) });
    const complete = JSON.parse((await session.tool({ request: page.review_pending[0] }, "rest")).text);
    expect(complete.review_pending).toEqual([]);
    await session.ensureIdle();
    await session.tool({ request: { operation: "run", task: "next check" } }, "accepted-next");
  });
  it.each([
    { name: "lost admission response", reply: async () => { throw new Error("Admission response lost after commit"); } },
    { name: "error tool result", reply: async () => ({ text: "Error: admission response lost" }) },
    { name: "malformed tool result", reply: async () => ({ text: "{" }) },
    { name: "missing run identity", reply: async () => ({ text: JSON.stringify({ status: "succeeded" }) }) },
  ])("blocks publication after $name even when the worker has completed the check", async ({ reply }) => {
    const f = fixture();
    const session = await openReviewWorkspace(f.deps, target);
    const workspace = await f.deps.state();
    f.tool.mockClear();
    f.tool.mockImplementationOnce(async () => {
      workspace.activeRunId = "unobserved-check";
      // Completion clears the active pointer without proving delivery of its result.
      delete workspace.activeRunId;
      return reply();
    });
    await session.tool({ request: { operation: "run", task: "check" } }, "uncertain").catch(() => {});
    await expect(session.ensureIdle()).rejects.toThrow("admission was not confirmed");
    expect(f.tool).toHaveBeenCalledOnce();
    expect(f.verify).not.toHaveBeenCalled();
    await expect(session.tool({ request: { operation: "run", task: "check" } }, "retry")).rejects.toThrow("no further commands");
    expect(f.tool).toHaveBeenCalledOnce();
    // An unrelated complete result cannot account for the uncertain admission.
    await session.tool({ request: { operation: "wait", run_id: "check" } }, "other-check");
    await expect(session.ensureIdle()).rejects.toThrow("admission was not confirmed");
  });
  it("keeps pending admissions fenced until their identity and output are observed", async () => {
    const f = fixture();
    const session = await openReviewWorkspace(f.deps, target);
    let respond!: (value: { text: string }) => void;
    f.tool.mockReturnValueOnce(new Promise(resolve => { respond = resolve; }));
    const pending = session.tool({ request: { operation: "run", task: "check" } }, "pending");
    await expect(session.ensureIdle()).rejects.toThrow("admission was not confirmed");
    respond({ text: JSON.stringify({ run_id: "check", status: "queued" }) });
    await pending;
    await expect(session.ensureIdle()).rejects.toThrow("results were not read");
    await session.tool({ request: { operation: "wait", run_id: "check" } }, "completed");
    await session.ensureIdle();
  });
  it("rejects permanent raw output loss even after a complete terminal page is delivered", async () => {
    const f = fixture();
    const session = await openReviewWorkspace(f.deps, target);
    f.tool.mockResolvedValueOnce({ text: JSON.stringify({ run_id: "check", status: "succeeded", next_seq: 1,
      has_more: false, truncated: false, output_loss: true }) });
    await session.tool({ request: { operation: "status", after_seq: 0 } }, "lost-output");
    await expect(session.ensureIdle()).rejects.toThrow("output was permanently omitted");
    expect(f.verify).not.toHaveBeenCalled();
  });
  it("closes a checkout with permanently missing output before opening review", async () => {
    const f = fixture();
    f.tool.mockResolvedValueOnce({ text: JSON.stringify({ workspace_id: "review", workspace_url: "https://studio.example.test/chats/review",
      run_id: "bootstrap", status: "succeeded", head_sha: target.headSha, output_loss: true }) });
    await expect(openReviewWorkspace(f.deps, target)).rejects.toThrow("checkout output was permanently omitted");
    expect(f.close).toHaveBeenCalledOnce();
  });
});
