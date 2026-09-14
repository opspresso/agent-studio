import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { createDockerSandboxBackend, dockerCall } from "@/infrastructure/workspace/dockerProvider";
import type { WorktreeReview } from "@/domain/coding/worktree";

async function main() {
  const { provider, control } = createDockerSandboxBackend({ image: process.env.WORKSPACE_SANDBOX_IMAGE || "agent-studio-workspace:agents",
    network: "none", memoryMb: 512, diskMb: 256, cpus: 1 });
  const workspaceId = `git-${randomUUID()}`;
  const containers = new Set<string>();
  try {
    const { externalId: id } = await provider.ensure(workspaceId);
    containers.add(id);
    const fixture = `
      const fs = require('node:fs'); const cp = require('node:child_process');
      const git = args => cp.execFileSync('git', args, {env:{...process.env,GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.test',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.test'},stdio:'pipe'});
      git(['init','-b','main','/control/source']);
      fs.writeFileSync('/control/source/hello.txt','before\\n');
      fs.writeFileSync('/control/source/.gitignore','node_modules/\\n');
      git(['-C','/control/source','add','.']); git(['-C','/control/source','commit','-m','fixture']);
      git(['clone','--bare','/control/source','/control/remote.git']);
      git(['--git-dir=/control/remote.git','update-server-info']);
      const server=cp.spawn('python3',['-m','http.server','8765','--bind','127.0.0.1','--directory','/control'],{detached:true,stdio:'ignore'});server.unref();
      setTimeout(()=>{},200);
    `;
    await dockerCall(["exec", "-i", "--user", "0", id, "node"], fixture);
    const repo = { url: "http://127.0.0.1:8765/remote.git", baseBranch: "main", branch: `agent/${workspaceId}` };
    const credential = { token: "ephemeral-test-credential", expiresAt: new Date(Date.now() + 60_000).toISOString() };
    const initial = await control<{ baseSha: string; headSha: string }>(id, "git-prepare", { ...repo, ...credential });
    assert.equal(initial.baseSha, initial.headSha);
    const run = (script: string) => provider.execute(id, { argv: ["/bin/sh", "-s"], stdin: script, timeoutMs: 10_000 });
    assert.equal((await run("cat hello.txt")).stdout, "before\n");
    const gitConfig = await run("git config --local --list");
    assert.ok(!gitConfig.stdout.includes(credential.token) && !gitConfig.stdout.includes("extraheader"), "Git configuration never stores the transient credential");
    await assert.rejects(control(id, "git-prepare", { ...repo, token: "long-lived-test", expiresAt: "2099-01-01T00:00:00Z" }), /short-lived/);
    assert.notEqual((await run("git checkout -b forbidden")).exitCode, 0, "agent cannot alter protected Git state");
    assert.notEqual((await run("rm .git")).exitCode, 0, "agent cannot replace the Git pointer");
    assert.equal((await run("printf after > hello.txt; printf added > new.txt; mkdir node_modules; truncate -s 70000000 node_modules/cache")).exitCode, 0);
    const review = await control<WorktreeReview>(id, "git-review", {});
    assert.match(review.diff, /new.txt/);
    assert.match(review.diff, /after/);
    assert.notEqual(review.treeSha, review.headTreeSha);
    const commit = { operationId: "approved-operation", fingerprint: review.fingerprint, message: "feat: change fixture",
      ownerEmail: "owner@example.test", createdAt: new Date().toISOString() };
    const result = await control<{ sha: string }>(id, "git-commit", commit);
    assert.equal((await control<{ sha: string }>(id, "git-commit", commit)).sha, result.sha, "same approved commit is idempotent");
    await assert.rejects(control(id, "git-commit", { ...commit, message: "changed message" }), /input changed/);
    const clean = await control<WorktreeReview>(id, "git-review", {});
    assert.equal(clean.headSha, result.sha);
    assert.equal(clean.diff, "");
    const snapshot = await provider.checkpoint(id);
    const entries = JSON.parse(gunzipSync(snapshot).toString("utf8")) as { content?: string }[];
    assert.ok(entries.every(entry => !entry.content || !Buffer.from(entry.content, "base64").toString("utf8").includes(credential.token)), "checkpoint contains no Git credential");
    await provider.destroy(id);
    const { externalId: restored } = await provider.ensure(workspaceId);
    containers.add(restored);
    await provider.restore(restored, snapshot);
    const restoredGit = await control<{ headSha: string }>(restored, "git-prepare", { ...repo, existingOnly: true });
    assert.equal(restoredGit.headSha, result.sha);
    const files = await provider.execute(restored, { argv: ["/bin/sh", "-c", "cat hello.txt new.txt; test ! -e node_modules/cache"], timeoutMs: 10_000 });
    assert.equal(files.stdout, "afteradded");
    assert.equal(files.exitCode, 0, "Git-ignored dependencies are regenerated instead of checkpointed");
    console.log("[ok] Workspace Git: clone, protected agent branch, full-tree review, approved commit identity, ignored caches and offline restore");
  } finally { for (const id of containers) await provider.destroy(id); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
