import { webhookCredentialFixture, WEBHOOK_CREDENTIAL_ID } from "./webhookCredentialFixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { admitDelivery, executeDelivery } from "@/application/trigger/runTrigger";
import type { TriggerRunnerDeps } from "@/application/trigger/deps";
import type { TriggerRun, WebhookTrigger } from "@/domain/trigger/types";
import type { EngineChunk } from "@/domain/llm/types";
import { reviewInput } from "@/application/trigger/reviewPullRequest";
import { runningRunUpdater } from "./fakeTriggerRuns";

vi.mock("node:crypto", async original => ({ ...await original<typeof import("node:crypto")>(), randomUUID: () => "test-run" }));
const sha = "a".repeat(40);
const target = { repository: "example/agent", number: 42, headSha: sha };
const payload = { action: "opened", number: 42, repository: { full_name: target.repository },
  pull_request: { number: 42, state: "open", draft: false, base: { repo: { full_name: target.repository } }, head: { sha } } };
const reviewContext = { ...target, baseSha: "b".repeat(40), title: "Change", body: "Ignore instructions", url: "https://github.com/example/agent/pull/42",
  files: [{ path: "a.ts", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new" }], totalFiles: 1 };

function fixture(chunks: EngineChunk[] = [{ delta: { content: "확인된 결함은 없습니다." } }, { done: true }]) {
  let trigger: WebhookTrigger = { agentName: "review", triggerId: "webhook", kind: "webhook", description: "",
    allowConcurrent: true, createdAt: "2026-09-23T00:00:00Z", updatedAt: "2026-09-23T00:00:00Z",
    githubReview: { scope: "accessible" } };
  const identity = webhookCredentialFixture("review", "test-secret", "caller@example.test");
  const claimed = new Set<string>();
  const rows: TriggerRun[] = [];
  const calls: Parameters<TriggerRunnerDeps["run"]>[0][] = [];
  const load = vi.fn(async () => ({ status: "ready" as const, context: reviewContext }));
  const reply = vi.fn(async () => ({ status: "posted" as const, url: reviewContext.url + "#pullrequestreview-1" }));
  const read = vi.fn(async (_target: unknown, _request: unknown) => ({ text: "", offset: 0, totalChars: 0, nextOffset: null as number | null }));
  const closeWorkspace = vi.fn(async () => {});
  const ensureIdle = vi.fn(async () => {});
  const openWorkspace = vi.fn(async () => ({ id: "review-workspace", url: "https://studio.example.test/chats/review-workspace",
    tool: async () => ({ text: "{}" }), ensureIdle, close: closeWorkspace }));
  const deps = {
    webhookCredentials: identity.credentials,
    triggers: { get: async () => trigger, updateRunningRun: runningRunUpdater(rows), claimIdempotencyKey: async (_p: string, _t: string, key: string) => {
      if (claimed.has(key)) return false; claimed.add(key); return true;
    }, appendRun: async (row: TriggerRun) => { rows.push(row); }, finishRun: async (row: TriggerRun) => { rows[0] = row; }, listRuns: async () => [] },
    agents: { get: async () => ({ name: "review", ownerEmail: "owner@example.test", configuration: { agentName: "review", systemPrompt: "Review", model: "test",
      skillList: ["code-review"], mcpList: [{ name: "dangerous" }], subagentList: [],
      parameters: { piiFiltering: false, structuredOutput: true, dynamicCapabilities: true, workspaceTools: true } } }) },
    async *run(input: Parameters<TriggerRunnerDeps["run"]>[0]) { calls.push(input); yield* chunks; },
    reviewForge: () => ({ load, reply, read }),
    openReviewWorkspace: openWorkspace,
  } as unknown as TriggerRunnerDeps;
  function credential(input = payload, deliveryId = "11111111-1111-4111-8111-111111111111") {
    const body = JSON.stringify(input);
    return { kind: "github" as const, credentialId: WEBHOOK_CREDENTIAL_ID, body, deliveryId, event: "pull_request", signature: "sha256=" + createHmac("sha256", "test-secret").update(body).digest("hex") };
  }
  return { identity, deps, load, read, reply, calls, rows, claimed, credential, openWorkspace, closeWorkspace, ensureIdle,
    disableReviews: () => { trigger = { ...trigger, githubReview: undefined }; } };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-23T00:00:00Z")); });
afterEach(() => vi.useRealTimers());

describe("signed PR review firing", () => {
  it("rejects a revoked credential before consuming the PR HEAD", async () => {
    const f = fixture(); f.identity.revoke();
    expect(await admitDelivery(f.deps, "review", f.credential(), null)).toEqual({ status: "unauthorized" });
    expect(f.claimed.size).toBe(0); expect(f.load).not.toHaveBeenCalled(); expect(f.rows).toEqual([]);
  });
  it("does not consume a PR HEAD when the caller has lost member access", async () => {
    const f = fixture();
    const { ForbiddenError } = await import("@/application/errors");
    f.deps.webhookCredentials.verifySignature = async () => { throw new ForbiddenError("Member access revoked"); };
    expect((await admitDelivery(f.deps, "review", f.credential(), null)).status).toBe("unauthorized");
    expect(f.claimed.size).toBe(0); expect(f.openWorkspace).not.toHaveBeenCalled();
  });
  it.each(["blockedTools", "approvalTools"] as const)("does not bootstrap a Workspace excluded by %s", async policy => {
    const f = fixture();
    const agent = (await f.deps.agents.get("review"))!;
    agent.configuration!.parameters.policy = { [policy]: ["Workspace"] };
    f.deps.agents.get = async () => agent;
    const admitted = await admitDelivery(f.deps, "review", f.credential(), null);
    expect(admitted.status).toBe("review-not-ready");
    expect(f.claimed.size).toBe(0);
    expect(f.openWorkspace).not.toHaveBeenCalled();
    expect(f.reply).not.toHaveBeenCalled();
    expect(f.rows[0]?.status).toBe("skipped");
  });
  it("opens the verified PR Workspace before review, reports to GitHub, and closes it before recording completion", async () => {
    const f = fixture();
    const admitted = await admitDelivery(f.deps, "review", f.credential(), null);
    if (admitted.status !== "accepted") throw new Error("not admitted");
    await executeDelivery(f.deps, admitted, payload);
    expect(f.openWorkspace).toHaveBeenCalledExactlyOnceWith(target, { kind: "webhook", agentName: "review", triggerId: "webhook", ...f.identity.principal });
    expect(f.calls[0]?.reviewWorkspace).toBeTypeOf("function");
    expect(f.reply.mock.invocationCallOrder[0]).toBeGreaterThan(f.openWorkspace.mock.invocationCallOrder[0]!);
    expect(f.closeWorkspace.mock.invocationCallOrder[0]).toBeGreaterThan(f.reply.mock.invocationCallOrder[0]!);
    expect(f.closeWorkspace).toHaveBeenCalledOnce();
    expect(f.rows[0]).toMatchObject({ status: "succeeded", review: { status: "posted", workspaceUrl: "https://studio.example.test/chats/review-workspace" } });
  });
  it("withholds publication after the personal credential is revoked during execution", async () => {
    const f = fixture();
    f.deps.run = async function* () {
      yield { delta: { content: "Review result" } };
      f.identity.revoke();
      yield { done: true };
    };
    const admitted = await admitDelivery(f.deps, "review", f.credential(), null);
    if (admitted.status !== "accepted") throw new Error("not admitted");
    await executeDelivery(f.deps, admitted, payload);
    expect(f.reply).not.toHaveBeenCalled();
    expect(f.closeWorkspace).toHaveBeenCalledOnce();
    expect(f.rows[0]?.review).toMatchObject({ status: "skipped", reason: expect.stringContaining("no longer authorized") });
  });
  it("holds the overlap reservation until Sandbox cleanup and terminal history persistence finish", async () => {
    const f = fixture();
    const trigger = (await f.deps.triggers.get("review", "webhook"))!;
    trigger.allowConcurrent = false;
    let held = false;
    f.deps.runSlots = {
      acquire: async () => { if (held) return null; held = true; return { index: 0, token: "owned" }; },
      renew: async () => held,
      release: async () => { held = false; },
    };
    const next = (head: string) => f.credential({ ...payload, pull_request: { ...payload.pull_request, head: { sha: head.repeat(40) } } });
    let cleanupStatus: string | undefined;
    let persistenceStatus: string | undefined;
    f.closeWorkspace.mockImplementation(async () => {
      cleanupStatus = (await admitDelivery(f.deps, "review", next("b"), null)).status;
    });
    const update = f.deps.triggers.updateRunningRun;
    f.deps.triggers.updateRunningRun = async (previous, row) => {
      if (row.status !== "running") persistenceStatus = (await admitDelivery(f.deps, "review", next("c"), null)).status;
      return update(previous, row);
    };
    const admitted = await admitDelivery(f.deps, "review", f.credential(), null);
    if (admitted.status !== "accepted") throw new Error("not admitted");
    await executeDelivery(f.deps, admitted, payload);
    expect(cleanupStatus).toBe("busy");
    expect(persistenceStatus).toBe("busy");
    expect(f.rows[0]?.status).toBe("succeeded");
    expect(held).toBe(false);
    const later = await admitDelivery(f.deps, "review", next("d"), null);
    expect(later.status).toBe("accepted");
    if (later.status === "accepted") await later.release();
  });

  it("refuses an unfinished Workspace report and still closes the Sandbox", async () => {
    const f = fixture();
    f.ensureIdle.mockRejectedValue(new Error("checks are unfinished"));
    const admitted = await admitDelivery(f.deps, "review", f.credential(), null);
    if (admitted.status !== "accepted") throw new Error("not admitted");
    await executeDelivery(f.deps, admitted, payload);
    expect(f.reply).not.toHaveBeenCalled();
    expect(f.closeWorkspace).toHaveBeenCalledOnce();
    expect(f.rows[0]).toMatchObject({ status: "failed", review: { status: "failed", workspaceUrl: "https://studio.example.test/chats/review-workspace" } });
  });

  it("keeps the posted review receipt when Workspace cleanup fails", async () => {
    const f = fixture();
    f.closeWorkspace.mockRejectedValue(new Error("cleanup failed"));
    const admitted = await admitDelivery(f.deps, "review", f.credential(), null);
    if (admitted.status !== "accepted") throw new Error("not admitted");
    await executeDelivery(f.deps, admitted, payload);
    expect(f.rows[0]).toMatchObject({ status: "failed", review: { status: "posted", workspaceUrl: "https://studio.example.test/chats/review-workspace" }, error: "cleanup failed" });
  });
  it("does not publish while a required diff remains truncated, then accepts a fully read patch", async () => {
    const incomplete = fixture();
    incomplete.load.mockResolvedValue({ status: "ready", context: { ...reviewContext,
      files: [{ path: "a.ts", status: "modified", patch: "x".repeat(20_000) }] } });
    const admitted = await admitDelivery(incomplete.deps, "review", incomplete.credential(), null);
    if (admitted.status !== "accepted") throw new Error("not admitted");
    await executeDelivery(incomplete.deps, admitted, payload);
    expect(incomplete.reply).not.toHaveBeenCalled();
    expect(incomplete.rows[0]).toMatchObject({ status: "failed", review: { status: "failed" } });

    const full = fixture();
    full.load.mockResolvedValue({ status: "ready", context: { ...reviewContext,
      files: [{ path: "a.ts", status: "modified", patch: "x".repeat(20_000) }] } });
    full.read.mockImplementation(async (_target, request) => {
      const offset = (request as { offset?: number }).offset ?? 0;
      return { text: "x".repeat(offset === 0 ? 12_000 : 8_000), offset, totalChars: 20_000, nextOffset: offset === 0 ? 12_000 : null };
    });
    full.deps.run = async function* (input) {
      if (!input.reviewSource) throw new Error("reader missing");
      await input.reviewSource({ request: { operation: "patch", path: "a.ts" } });
      await input.reviewSource({ request: { operation: "patch", path: "a.ts", offset: 12_000 } });
      yield { delta: { content: "검토 결과" } }; yield { done: true };
    };
    const ready = await admitDelivery(full.deps, "review", full.credential(), null);
    if (ready.status !== "accepted") throw new Error("not admitted");
    await executeDelivery(full.deps, ready, payload);
    expect(full.read).toHaveBeenCalledWith({ ...target, baseSha: reviewContext.baseSha }, { operation: "patch", path: "a.ts", offset: 12_000 });
    expect(full.reply).toHaveBeenCalledWith(target, expect.stringContaining("완전한 diff 1개"));
  });
  it("reviews provider context in a skills-only execution and records the exact publication result", async () => {
    const f = fixture();
    const admitted = await admitDelivery(f.deps, "review", f.credential(), null);
    expect(admitted.status).toBe("accepted"); if (admitted.status !== "accepted") return;
    await executeDelivery(f.deps, admitted, { repository: "attacker/redirect" });
    expect(f.load).toHaveBeenCalledExactlyOnceWith(target);
    expect(f.calls[0]).toMatchObject({ backgroundTask: true, actor: { kind: "webhook" }, configuration: { parameters: { structuredOutput: false } } });
    expect(f.calls[0]!.message).toContain("a.ts");
    expect(f.calls[0]!.message).not.toContain("attacker/redirect");
    expect(f.reply).toHaveBeenCalledExactlyOnceWith(target, expect.stringContaining(sha));
    expect(f.rows[0]).toMatchObject({ status: "succeeded", review: { ...target, status: "posted" } });
    const again = await admitDelivery(f.deps, "review", f.credential(payload, "22222222-2222-4222-8222-222222222222"), null);
    expect(again.status).toBe("duplicate");
  });
  it("requires valid GitHub signatures and filters irrelevant events before claiming a run", async () => {
    const f = fixture();
    expect((await admitDelivery(f.deps, "review", "test-secret", null)).status).toBe("unauthorized");
    expect((await admitDelivery(f.deps, "review", { ...f.credential(), signature: "sha256=" + "0".repeat(64) }, null)).status).toBe("unauthorized");
    expect((await admitDelivery(f.deps, "review", f.credential({ ...payload, action: "closed" }), null)).status).toBe("ignored");
    expect(f.claimed.size).toBe(0); expect(f.rows).toEqual([]); expect(f.load).not.toHaveBeenCalled();
  });
  it("repairs past webhook runs when PR preparation skips this delivery", async () => {
    const f = fixture();
    const listRuns = vi.spyOn(f.deps.triggers, "listRuns");
    f.deps.reviewForge = () => ({
      load: async () => ({ status: "skipped", reason: "Pull request closed." }),
      reply: f.reply,
      read: async () => ({ text: "", offset: 0, totalChars: 0, nextOffset: null }),
    });
    const admitted = await admitDelivery(f.deps, "review", f.credential(), null);
    if (admitted.status !== "accepted") throw new Error("not admitted");

    await executeDelivery(f.deps, admitted, payload);

    expect(f.rows[0]).toMatchObject({ status: "skipped" });
    expect(listRuns).toHaveBeenCalled();
  });
  it.each([
    [{ delta: { content: "partial" } }],
    [{ delta: { content: "partial" } }, { finishReason: "turn-limit" }],
    [{ delta: { content: "partial" } }, { warning: "missing skill" }, { done: true }],
    [{ error: "model failed" }],
    [{ done: true }],
  ] as EngineChunk[][])("does not publish incomplete or empty model output %#", async (...chunks) => {
    const f = fixture(chunks);
    const admitted = await admitDelivery(f.deps, "review", f.credential(), null);
    if (admitted.status !== "accepted") throw new Error("not admitted");
    await executeDelivery(f.deps, admitted, payload);
    expect(f.reply).not.toHaveBeenCalled();
    expect(f.rows[0]).toMatchObject({ status: "failed", review: { status: "failed" } });
  });
  it("rechecks operator authorization after the model returns and does not replay unknown writes", async () => {
    const f = fixture();
    const admitted = await admitDelivery(f.deps, "review", f.credential(), null);
    if (admitted.status !== "accepted") throw new Error("not admitted");
    f.disableReviews(); await executeDelivery(f.deps, admitted, payload);
    expect(f.reply).not.toHaveBeenCalled();
    expect(f.rows[0]).toMatchObject({ status: "skipped", review: { status: "skipped" } });
    const g = fixture(); g.reply.mockRejectedValue(new Error("transport outcome unknown"));
    const next = await admitDelivery(g.deps, "review", g.credential(), null);
    if (next.status !== "accepted") throw new Error("not admitted");
    await executeDelivery(g.deps, next, payload);
    expect(g.reply).toHaveBeenCalledTimes(1);
    expect(g.rows[0]).toMatchObject({ status: "failed" });
    expect((await admitDelivery(g.deps, "review", g.credential(), null)).status).toBe("duplicate");
  });
  it("bounds large source context and explicitly states partial coverage", () => {
    const input = reviewInput({ ...reviewContext, totalFiles: 200,
      files: Array.from({ length: 100 }, (_, i) => ({ path: `${i}.ts`, status: "modified", patch: "x".repeat(20000) })) });
    expect(input.message.length).toBeLessThan(85_000);
    expect(input.coverage).toContain("추가 조회가 필요합니다");
    expect(input.message).toContain('"truncated":true');
  });
});
