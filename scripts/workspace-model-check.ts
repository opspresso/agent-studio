import assert from "node:assert/strict";
import { build } from "esbuild";
import { randomUUID } from "node:crypto";
import { createDockerSandboxBackend, dockerCall } from "@/infrastructure/workspace/dockerProvider";
import { createWorkspaceRuntimeAdapter, withWorkspaceModelChannel } from "@/infrastructure/workspace/runtimeAdapters";
import type { Workspace, RuntimeSession, WorkspaceModelRuntime } from "@/domain/workspace/types";
import type { WorkspaceModelSelection } from "@/application/workspace/modelGateway";
import type { UsageDelta } from "@/domain/usage/types";

/** Actual pinned CLIs and the server gateway run offline; no external provider or credential. */
async function main() {
  const bundle = await build({ entryPoints: ["scripts/fixtures/workspace-model-gateway.ts"], bundle: true, write: false, platform: "node", format: "cjs", target: "node24" });
  const { provider } = createDockerSandboxBackend({ image: process.env.WORKSPACE_SANDBOX_IMAGE || "agent-studio-workspace:agents", network: "none", memoryMb: 2048, diskMb: 1024, cpus: 2 });
  const { externalId } = await provider.ensure("model-gateway-" + randomUUID());
  try {
    await dockerCall(["exec", "-i", "--user", "0", externalId, "node", "-e",
      "let source=''; process.stdin.on('data',c=>source+=c); process.stdin.on('end',()=>{require('node:fs').writeFileSync('/control/model-gateway.cjs',source);const p=require('node:child_process').spawn('node',['/control/model-gateway.cjs'],{detached:true,stdio:'ignore'});p.unref();})"], bundle.outputFiles[0]!.text);
    await dockerCall(["exec", externalId, "node", "-e", "const fs=require('node:fs');const until=Date.now()+5000;function tick(){if(fs.existsSync('/control/model-gateway-ready'))return;if(Date.now()>until)process.exit(1);setTimeout(tick,10)}tick()"]);
    for (const runtime of ["codex", "claude", "opencode"] as WorkspaceModelRuntime[]) {
      const id = randomUUID();
      const workspace = { id, runtime, sessionId: id, title: "Gateway validation" } as Workspace;
      const session = { id, runtime, workspaceId: id } as RuntimeSession;
      for (let run = 1; run <= 2; run++) {
        const credential = JSON.parse(await dockerCall(["exec", externalId, "node", "-e",
          `fetch('http://127.0.0.1:19090/credential?runtime=${runtime}&run=${run}').then(r=>r.text()).then(s=>process.stdout.write(s))`])) as { token: string; selected: WorkspaceModelSelection };
        const config = withWorkspaceModelChannel(runtime, { model: credential.selected.wireModel }, { name: credential.selected.protocol === "responses" ? "openai" : "studio",
          baseUrl: "http://127.0.0.1:19090/api/workspace-model/v1", apiKey: credential.token });
        assert.ok(!JSON.stringify(config).includes("synthetic-provider-key"));
        const adapter = createWorkspaceRuntimeAdapter(runtime, config);
        const result = await provider.execute(externalId, adapter.command(workspace, session, { kind: "task", prompt: run === 1 ? "Reply only gateway-ok." : "Continue: reply only gateway-ok." }, 45_000));
        if (result.exitCode !== 0) console.error(await dockerCall(["exec", externalId, "cat", "/control/model-gateway-shape.json"]));
        assert.equal(result.exitCode, 0, `${runtime}: ${result.stderr.slice(-2000)} ${result.stdout.slice(-1000)}`);
        const events = result.stdout.split("\n").flatMap(line => adapter.events(line));
        assert.ok(events.some(event => event.kind === "message" && event.text.includes("gateway-ok")), `${runtime} actual model reply`);
        const started = events.find(event => event.kind === "session");
        if (!session.nativeSessionId) { assert.ok(started?.kind === "session"); session.nativeSessionId = started.nativeSessionId; }
        else if (started?.kind === "session") assert.equal(started.nativeSessionId, session.nativeSessionId);
      }
    }
    const report = JSON.parse(await dockerCall(["exec", externalId, "node", "-e", "fetch('http://127.0.0.1:19090/report').then(r=>r.text()).then(s=>process.stdout.write(s))"])) as {
      requests: Array<{ model: string; path: string; authorized: boolean }>; usage: UsageDelta[]; pending: number;
    };
    assert.equal(report.pending, 0);
    assert.ok(report.requests.every(request => request.authorized));
    assert.equal(report.usage.length, report.requests.length, "every provider request, including hidden helper calls, is recorded exactly once");
    assert.ok(report.usage.every(row => row.userId === "fixture-user" && row.actor === "user:fixture@example.test" && row.inputTokens > 0 && row.outputTokens > 0));
    for (const runtime of ["codex", "claude", "opencode"]) {
      const rows = report.usage.filter(row => row.model === `fixture/${runtime}`);
      assert.ok(rows.length >= 2, `${runtime} start/resume accounted`);
      assert.ok(rows.every(row => row.inputTokens === (runtime === "claude" ? 15 : 10) && row.outputTokens === 2), "request counters do not double count resumed history");
      console.log(`[ok] ${runtime} start/resume through scoped gateway: ${rows.length} provider calls accounted`);
    }
  } finally { await provider.destroy(externalId); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
