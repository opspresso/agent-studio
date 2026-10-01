import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { assertLocalDatabase } from "./local-database";
import type { WorkspaceWorkerDeps } from "@/application/workspace/worker";
import type { ExecutionDeps } from "@/application/execution/deps";
import type { TriggerRunnerDeps } from "@/application/trigger/deps";
import { FakeChannel, contentChunk, toolCallChunk } from "../tests/fakeChannel";
import { triggerSecretContext } from "@/domain/security/secretContext";

process.env.DATABASE_URL ??= "postgres://agent_studio:agent_studio@127.0.0.1:5432/agent_studio_test";
assertLocalDatabase(process.env.DATABASE_URL, true);
process.env.AES_ENCRYPTION_KEY ??= Buffer.alloc(32, 11).toString("base64");

/** Real SQL, signed webhook, Git HTTP, Sandbox, SDK tools and cleanup; only model/GitHub responses are scripted. */
async function main() {
  const directory = await mkdtemp(join(tmpdir(), "pr-review-check-"));
  let server: ReturnType<typeof createServer> | undefined;
  try {
  const source = join(directory, "source");
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" }, encoding: "utf8", stdio: "pipe" }).trim();
  await mkdir(source);
  git("init", "-b", "main", source);
  await writeFile(join(source, "index.js"), "exports.twice = x => x * 2;\n");
  git("-C", source, "add", "."); git("-C", source, "commit", "-m", "baseline");
  const baseSha = git("-C", source, "rev-parse", "HEAD");
  git("-C", source, "branch", "base", baseSha);
  await writeFile(join(source, "index.js"), "exports.twice = x => x * 3;\n");
  git("-C", source, "add", "."); git("-C", source, "commit", "-m", "regression");
  const headSha = git("-C", source, "rev-parse", "HEAD");
  git("-C", source, "branch", "feature");
  await writeFile(join(source, "future.txt"), "not part of the reviewed commit\n");
  git("-C", source, "add", "."); git("-C", source, "commit", "-m", "later main");
  await mkdir(join(directory, "fixture"));
  git("clone", "--bare", source, join(directory, "fixture", "repo.git"));
  git("--git-dir=" + join(directory, "fixture", "repo.git"), "config", "http.receivepack", "false");
  const receipts: Array<Record<string, unknown>> = [];
  let baseUrl = "";
  const pull = () => ({ number: 1, state: "open", draft: false, title: "Arithmetic regression", body: "Review the arithmetic change", changed_files: 1,
    html_url: `${baseUrl}/fixture/repo/pull/1`, head: { sha: headSha, ref: "feature", repo: { full_name: "fixture/repo" } },
    base: { sha: baseSha, ref: "base", repo: { full_name: "fixture/repo" } } });
  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url!, "http://localhost");
      const bytes: Buffer[] = []; for await (const chunk of request) bytes.push(Buffer.from(chunk));
      const body = Buffer.concat(bytes);
      if (url.pathname.startsWith("/api/")) {
        let value: unknown;
        if (url.pathname.endsWith("/files")) value = [{ filename: "index.js", status: "modified", patch: "@@ -1 +1 @@\n-exports.twice = x => x * 2;\n+exports.twice = x => x * 3;" }];
        else if (url.pathname.endsWith("/reviews") && request.method === "POST") { receipts.push(JSON.parse(body.toString())); value = { id: 1, commit_id: headSha, state: "COMMENTED", html_url: `${baseUrl}/fixture/repo/pull/1#pullrequestreview-1` }; }
        else if (url.pathname.includes("/commits/")) value = { sha: headSha };
        else if (url.pathname.endsWith("/pulls/1")) value = pull();
        else { response.writeHead(404).end(); return; }
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(value)); return;
      }
      // Git's documented CGI protocol serves this isolated bare fixture, with receive-pack disabled.
      const child = execFile("git", ["http-backend"], { encoding: "buffer", maxBuffer: 4 * 1024 * 1024, env: { ...process.env,
        GIT_PROJECT_ROOT: directory, GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: request.method!, CONTENT_TYPE: request.headers["content-type"] ?? "", CONTENT_LENGTH: String(body.length),
        GIT_PROTOCOL: String(request.headers["git-protocol"] ?? "") } }, (error, stdout) => {
        if (error) { response.writeHead(500).end(); return; }
        const end = stdout.indexOf("\r\n\r\n"); const headers: Record<string, string> = {}; let status = 200;
        for (const line of stdout.subarray(0, end).toString().split("\r\n")) {
          const separator = line.indexOf(":"); if (separator < 0) continue;
          const name = line.slice(0, separator); const value = line.slice(separator + 1).trim();
          if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]); else headers[name] = value;
        }
        response.writeHead(status, headers).end(stdout.subarray(end + 4));
      });
      child.stdin!.end(body);
    } catch { response.writeHead(500).end(); }
  });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://localhost:${(server.address() as { port: number }).port}`;
  const { migrate } = await import("@/infrastructure/db/migrations"); await migrate();
  const { workspaceRepository: repository } = await import("@/infrastructure/db/repositories/workspaceRepository");
  const { agentRepository: storedAgents } = await import("@/infrastructure/db/repositories/agentRepository");
  const { chatRepository: chats } = await import("@/infrastructure/db/repositories/chatRepository");
  const { triggerRepository: triggers } = await import("@/infrastructure/db/repositories/triggerRepository");
  const { usageRepository: usage } = await import("@/infrastructure/db/repositories/usageRepository");
  const { secretCipher: cipher } = await import("@/infrastructure/crypto/secretCipher");
  const { createWorkspaceCheckpointStore } = await import("@/infrastructure/db/repositories/workspaceCheckpointStore");
  const { createDockerSandboxBackend } = await import("@/infrastructure/workspace/dockerProvider");
  const { createCodingWorktree } = await import("@/infrastructure/workspace/gitWorktree");
  const { createCodingGitHub } = await import("@/infrastructure/github/codingForge");
  const { createWorkspaceRuntimeAdapter, WORKSPACE_DIRECTORY } = await import("@/infrastructure/workspace/runtimeAdapters");
  const { createWorkspaceUseCases } = await import("@/application/workspace/workspaceUseCases");
  const { createWorkspaceTool } = await import("@/application/workspace/workspaceTool");
  const { openReviewWorkspace } = await import("@/application/workspace/reviewWorkspace");
  const { processWorkspace } = await import("@/application/workspace/worker");
  const { streamAgentRun, executeWorkspaceTask } = await import("@/application/execution/runAgent");
  const { createToolSchemaValidator } = await import("@/infrastructure/llm/toolSchema");
  const { admitDelivery, executeDelivery } = await import("@/application/trigger/runTrigger");
  const { deletePartition } = await import("@/infrastructure/db/store");
  const { keys } = await import("@/infrastructure/db/keys");
  const { closePool } = await import("@/infrastructure/db/client");
  const agentName = `review-${randomUUID()}`; const ownerEmail = "review-check@example.test"; const at = new Date().toISOString();
  const configuration = { agentName, model: "openai/gpt-5-mini", systemPrompt: "Review the verified PR", parameters: { piiFiltering: false, workspaceTools: true }, skillList: [], mcpList: [], subagentList: [] };
  const agents = { ...storedAgents, get: async (name: string) => { const agent = await storedAgents.get(name); return agent ? { ...agent, configuration } : null; } };
  const sandbox = { image: process.env.WORKSPACE_SANDBOX_IMAGE || "agent-studio-workspace:agents", network: "none", memoryMb: 512, diskMb: 256, cpus: 1 };
  const backend = createDockerSandboxBackend(sandbox); const nativeProvider = backend.provider; const containers = new Set<string>();
  const provider = { ...nativeProvider, ensure: async (id: string) => { const value = await nativeProvider.ensure(id); containers.add(value.externalId); return value; } };
  const checkpoints = createWorkspaceCheckpointStore(cipher);
  const coding = createCodingWorktree(backend.control, { webUrl: baseUrl, internalHosts: ["localhost"], serverToken: async () => "fixture-token" });
  const github = createCodingGitHub({ apiUrl: `${baseUrl}/api`, webUrl: baseUrl, internalHosts: ["localhost"], getToken: async () => "fixture-token" });
  let workspaceId: string | undefined;
  const worker: WorkspaceWorkerDeps = { repository, chats, agents, provider, checkpoints, coding: () => coding, now: () => new Date(), newId: randomUUID,
    idleTtlSeconds: 60, runTimeoutMs: 30000, policy: () => ({ agentName, runtimes: ["command"], repositories: ["fixture/repo"], checks: [], deploymentWorkflows: [] }),
    checkRepository: (_agentName, repository, branch, revision) => github.forge.checkRepository(repository, branch, revision), runtime: createWorkspaceRuntimeAdapter,
    execute: (workspace, work, actor) => executeWorkspaceTask({ usage }, agents, workspace, work, actor), sleep: ms => delay(ms) };
  const api = createWorkspaceUseCases(worker);
  const pump = async () => { if (workspaceId) await processWorkspace(worker, workspaceId); };
  const channel = new FakeChannel([
    [toolCallChunk(0, "check", "Workspace", JSON.stringify({ request: { operation: "run", task: "test ! -e future.txt && node -e \"if(require('./index.js').twice(1)!==2) throw new Error('expected 2, got 3')\"" } }))],
    [toolCallChunk(0, "wait", "Workspace", JSON.stringify({ request: { operation: "wait" } }))],
    [contentChunk("[P1] index.js:1 — twice(1)이 2 대신 3을 반환합니다. Workspace 재현 검사가 실패했습니다.")],
  ]);
  const execution = { agents, usage, cipher, channel, createToolSchemaValidator, skills: { get: async () => null, describe: async () => [] }, mcps: { get: async () => null } } as unknown as ExecutionDeps;
  const actor = { kind: "webhook" as const, id: `${agentName}:webhook` };
  const deps: TriggerRunnerDeps = { members: { getById: async () => null }, agents, triggers, cipher, executionUserActive: async () => true, reviewForge: () => github.reviews,
    run: input => streamAgentRun(execution, { ...input, messages: [{ role: "user", content: input.message ?? "" }], ownerEmail: input.userEmail }),
    openReviewWorkspace: async target => {
      const tool = createWorkspaceTool({ useCases: api, authorize: async () => {}, policy: () => worker.policy(agentName), sleep: pump, workdir: WORKSPACE_DIRECTORY, publicBaseUrl: baseUrl,
        publishGit: async () => { throw new Error("Git publication unavailable"); }, requestGit: async () => { throw new Error("Git publication must be unavailable"); }, pullRequest: async () => undefined, attachRepository: async () => { throw new Error("Repository must remain pinned"); } },
        { agentName, ownerEmail, actor, occurrence: randomUUID(), reviewTarget: target });
      const wrapped = async (...args: Parameters<typeof tool>) => { const result = await tool(...args); const value = JSON.parse(result.text); workspaceId ??= value.workspace_id; return result; };
      return openReviewWorkspace({ tool: wrapped, state: repository.get, close: id => api.close(id, ownerEmail), sleep: pump, verify: async id => {
        const workspace = (await repository.get(id))!;
        const sandbox = (await repository.sandbox(id, workspace.sandboxId!))!;
        return coding.review(sandbox.externalId);
      } }, target);
    } };
  try {
    await storedAgents.create({ name: agentName, displayName: "PR review check", description: "", ownerEmail, createdAt: at, updatedAt: at });
    const secret = "fixture-webhook-secret";
    await triggers.create({ agentName, triggerId: "webhook", kind: "webhook", description: "", enabled: true, secret: cipher.encrypt(secret, triggerSecretContext(agentName, "webhook")), executionEmail: ownerEmail,
      allowConcurrent: true, githubReview: { scope: "repositories", repositories: ["fixture/repo"] }, createdAt: at, updatedAt: at });
    const storedWebhook = await triggers.get(agentName, "webhook");
    assert.equal(storedWebhook?.kind === "webhook" && storedWebhook.executionEmail, ownerEmail, "Webhook execution delegation must survive the DB round-trip");
    const body = JSON.stringify({ action: "opened", number: 1, repository: { full_name: "fixture/repo" }, pull_request: pull() });
    const credential = { kind: "github" as const, body, event: "pull_request", deliveryId: randomUUID(), signature: "sha256=" + createHmac("sha256", secret).update(body).digest("hex") };
    const admitted = await admitDelivery(deps, agentName, credential, null);
    assert.equal(admitted.status, "accepted"); if (admitted.status !== "accepted") throw new Error("Webhook not admitted");
    await executeDelivery(deps, admitted, JSON.parse(body));
    const history = (await triggers.listRuns(agentName, "webhook", 10))[0]!;
    assert.equal(history.status, "succeeded", history.error ?? "Trigger failed");
    assert.equal(history.review?.status, "posted");
    assert.equal(receipts.length, 1); assert.equal(receipts[0]!.commit_id, headSha); assert.equal(receipts[0]!.event, "COMMENT");
    assert.match(String(receipts[0]!.body), /index.js:1/); assert.match(String(receipts[0]!.body), /Workspace/);
    const workspace = (await repository.get(workspaceId!))!;
    assert.equal(workspace.status, "closed"); assert.equal(workspace.sandboxId, undefined);
    for (const id of containers) assert.equal(await nativeProvider.inspect(id), "missing", "Review Sandbox must be removed before completion");
    assert.equal(workspace.coding?.headSha, headSha); assert.equal(workspace.coding.sourceRevision, headSha);
    const runs = await repository.runs(workspace.id, 10);
    assert.equal(runs.length, 2); assert.equal(runs[0]!.status, "failed"); assert.equal(runs[1]!.status, "succeeded");
    const events = await repository.events(workspace.id, runs[0]!.id, 0, 100);
    assert.ok(events.some(event => event.data.kind === "output" && event.data.text.includes("expected 2, got 3")), "The actual Sandbox must reproduce the arithmetic defect");
    for (const run of runs) assert.deepEqual(run.actor, actor);
    assert.equal((await admitDelivery(deps, agentName, { ...credential, deliveryId: randomUUID() }, null)).status, "duplicate");
    console.log("PASS signed PR webhook → immutable checkout (main advanced) → real SDK Workspace check → COMMENT at exact HEAD → closed Workspace, cleanup and duplicate refusal");
  } finally {
    if (workspaceId) { await api.close(workspaceId, ownerEmail); await processWorkspace(worker, workspaceId); await checkpoints.delete(workspaceId);
      const workspace = await repository.get(workspaceId); if (workspace) await chats.delete(workspace.chatId); await deletePartition(keys.workspacePartition(workspaceId)); }
    if (await storedAgents.get(agentName)) await storedAgents.delete(agentName);
    for (const id of containers) await nativeProvider.destroy(id);
    await closePool();
  }
  } finally {
    if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
