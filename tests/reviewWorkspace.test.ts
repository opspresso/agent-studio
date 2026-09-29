import { describe, expect, it, vi } from "vitest";
import { openReviewWorkspace } from "@/application/workspace/reviewWorkspace";
import type { Workspace } from "@/domain/workspace/types";

const target = { repository: "org/repo", number: 130, headSha: "a".repeat(40) };
function fixture(bootstrap = "succeeded") {
  let workspace = { id: "review", status: "active", coding: { repository: target.repository, sourceRevision: target.headSha, headSha: target.headSha } } as Workspace;
  const tool = vi.fn(async (args: Record<string, unknown>) => {
    const request = args.request as { operation: string };
    return { text: JSON.stringify({ workspace_id: workspace.id, workspace_url: "https://studio.example.test/chats/review", run_id: "check",
      status: request.operation === "start" ? "queued" : request.operation === "run" ? "queued" : bootstrap, head_sha: target.headSha }) };
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
});
