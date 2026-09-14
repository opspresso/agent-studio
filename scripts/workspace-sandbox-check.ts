import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { createDockerSandboxBackend } from "@/infrastructure/workspace/dockerProvider";

/** Disposable, network-isolated containers; never uses host credentials or a host volume. */
async function main() {
  const { provider, control } = createDockerSandboxBackend({ image: process.env.WORKSPACE_SANDBOX_IMAGE || "agent-studio-workspace:test",
    network: "none", memoryMb: 512, diskMb: 256, cpus: 1 });
  const workspaceId = `smoke-${randomUUID()}`;
  const containers = new Set<string>();
  const run = (id: string, script: string) => provider.execute(id, { argv: ["/bin/sh", "-s"], stdin: script, timeoutMs: 10_000 });
  try {
    const { externalId: id } = await provider.ensure(workspaceId);
    containers.add(id);
    assert.equal((await provider.ensure(workspaceId)).externalId, id, "ensure reuses the same container");
    assert.equal(await provider.inspect(id), "ready");
    if (process.env.WORKSPACE_TEST_AGENTS === "true") {
      for (const executable of ["codex", "claude", "opencode"]) {
        const version = await provider.execute(id, { argv: [executable, "--version"], timeoutMs: 10_000 });
        assert.equal(version.exitCode, 0, `${executable} must execute as a non-root sandbox user: ${version.stderr}`);
        assert.match(version.stdout, /\d+\.\d+/);
      }
    }
    assert.equal((await run(id, "id -u")).stdout.trim(), "1000");
    assert.equal((await run(id, 'test -d "$CODEX_HOME" && test -w "$CODEX_HOME"')).exitCode, 0, "native runtime home exists before the first task");
    assert.equal((await run(id, "printf '#!/bin/sh\\nprintf executable' > executable.sh; chmod +x executable.sh; ./executable.sh")).stdout, "executable", "workspace package binaries must execute");
    assert.notEqual((await run(id, "touch /opt/cannot-write")).exitCode, 0);
    assert.notEqual((await run(id, "ls /control/operations")).exitCode, 0);
    assert.equal((await run(id, "test ! -e /var/run/docker.sock && test -z \"$DATABASE_URL$AWS_SECRET_ACCESS_KEY$GITHUB_TOKEN\" && echo isolated")).stdout.trim(), "isolated");
    assert.equal((await run(id, "printf first > state.txt; mkdir -p \"$HOME/.codex/sessions\"; printf native > \"$HOME/.codex/sessions/session.jsonl\"; printf excluded > \"$HOME/.codex/auth.json\"; ln -s state.txt state-link")).exitCode, 0);
    assert.equal((await run(id, "printf second >> state.txt; cat state.txt")).stdout, "firstsecond");
    await assert.rejects(control(id, "git-prepare", { branch: "agent/preserve-files", baseBranch: "main", url: "https://example.com/repo.git" }), /workdir is not empty/);
    assert.equal((await run(id, "cat state.txt")).stdout, "firstsecond", "repository attachment must not overwrite task files");
    assert.equal((await run(id, "printf private > locked.txt; chmod 000 locked.txt")).exitCode, 0);
    assert.equal((await run(id, 'mkdir -p "$HOME/.codex/.tmp" "$HOME/.npm"; truncate -s 70000000 "$HOME/.npm/cache"; ln -s /usr/bin/node "$HOME/.codex/.tmp/alias"')).exitCode, 0);

    const operationId = "stable-operation";
    const command = { argv: ["/bin/sh", "-s"], stdin: "printf once >> state.txt; echo streamed; sleep 1; echo ended", timeoutMs: 10_000 };
    await provider.start(id, operationId, command);
    await provider.start(id, operationId, command);
    let state = await provider.operation(id, operationId);
    const deadline = Date.now() + 15_000;
    while ((state.status === "running" || state.status === "starting") && Date.now() < deadline) {
      await delay(100);
      state = await provider.operation(id, operationId);
    }
    assert.equal(state.status, "succeeded");
    const output = await provider.output(id, operationId, 0);
    assert.match(output.frames.map(frame => frame.text).join(""), /streamed/);
    assert.match(output.frames.map(frame => frame.text).join(""), /ended/);
    assert.deepEqual((await provider.output(id, operationId, output.nextOffset)).frames, []);
    assert.equal((await run(id, "cat state.txt")).stdout, "firstsecondonce", "duplicate start never executes twice");
    await provider.start(id, "unicode-operation", { argv: ["node", "-e", "process.stdout.write('x'.repeat(1999) + '😀')"], timeoutMs: 10_000 });
    for (let attempt = 0; attempt < 30 && (await provider.operation(id, "unicode-operation")).status !== "succeeded"; attempt++) await delay(100);
    const unicode = await provider.output(id, "unicode-operation", 0);
    for (const frame of unicode.frames) {
      assert.equal(Buffer.from(frame.text, "utf8").toString("utf8"), frame.text, "every persisted frame contains complete Unicode characters");
    }

    await provider.start(id, "next-operation", { argv: ["/bin/sh", "-s"], stdin: "sleep 1; echo next", timeoutMs: 10_000 });
    await provider.cancel(id, operationId);
    for (let attempt = 0; attempt < 30 && !["succeeded", "failed"].includes((await provider.operation(id, "next-operation")).status); attempt++) await delay(100);
    assert.equal((await provider.operation(id, "next-operation")).status, "succeeded", "late cancellation cannot stop the next operation");

    await provider.start(id, "cancel-operation", { argv: ["/bin/sh", "-s"], stdin: "sleep 60", timeoutMs: 70_000 });
    for (let attempt = 0; attempt < 30 && (await provider.operation(id, "cancel-operation")).status !== "running"; attempt++) await delay(100);
    await provider.cancel(id, "cancel-operation");
    for (let attempt = 0; attempt < 30 && (await provider.operation(id, "cancel-operation")).status === "running"; attempt++) await delay(100);
    assert.equal((await provider.operation(id, "cancel-operation")).status, "failed");

    const checkpoint = await provider.checkpoint(id);
    await provider.destroy(id);
    assert.equal(await provider.inspect(id), "missing");
    await provider.destroy(id);
    const { externalId: restored } = await provider.ensure(workspaceId);
    containers.add(restored);
    assert.notEqual(restored, id, "recreated compute has a new immutable handle");
    await provider.restore(restored, checkpoint);
    assert.equal((await run(restored, "cat state-link; cat \"$HOME/.codex/sessions/session.jsonl\"")).stdout, "firstsecondoncenative");
    assert.equal((await run(restored, "test ! -e \"$HOME/.codex/auth.json\" && echo excluded")).stdout.trim(), "excluded");
    assert.equal((await run(restored, "stat -c %a locked.txt")).stdout.trim(), "0", "file permissions survive restoration");
    assert.equal((await run(restored, 'test ! -e "$HOME/.npm/cache" && test ! -e "$HOME/.codex/.tmp/alias"')).exitCode, 0, "regenerable native and package caches do not enter checkpoints");
    await assert.rejects(provider.restore(restored, checkpoint), /empty sandbox/);

    const { externalId: empty } = await provider.ensure(`invalid-${randomUUID()}`);
    containers.add(empty);
    const attack = gzipSync(JSON.stringify([{ path: "repo/../../control/evil", kind: "file", content: "eA==" }]));
    await assert.rejects(provider.restore(empty, attack), /checkpoint path/);
    const linkAttack = gzipSync(JSON.stringify([{ path: "repo/link", kind: "link", target: "/control" }]));
    await assert.rejects(provider.restore(empty, linkAttack), /checkpoint link/);
    console.log("[ok] Docker sandbox: isolation, file continuity, exact operation identity, output replay, cancel, checkpoint and restore");
  } finally {
    for (const id of containers) await provider.destroy(id);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
