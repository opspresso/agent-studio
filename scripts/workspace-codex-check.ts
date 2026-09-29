import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDockerSandboxBackend, dockerCall } from "@/infrastructure/workspace/dockerProvider";
import { createWorkspaceRuntimeAdapter, withWorkspaceModelChannel } from "@/infrastructure/workspace/runtimeAdapters";
import type { Workspace, RuntimeSession } from "@/domain/workspace/types";

/** Real pinned CLI, a loopback Responses fixture and no external network or credentials. */
async function main() {
  const { provider } = createDockerSandboxBackend({ image: process.env.WORKSPACE_SANDBOX_IMAGE || "agent-studio-workspace:agents",
    network: "none", memoryMb: 1024, diskMb: 512, cpus: 1 });
  const id = `codex-routing-${randomUUID()}`;
  const { externalId } = await provider.ensure(id);
  try {
    // The fixture runs as the control-plane user so normal workload cleanup cannot kill it.
    await dockerCall(["exec", "-i", "--user", "0", externalId, "node"], `
      const {spawn} = require('node:child_process');
      const server = ${JSON.stringify(String.raw`
        const fs = require('node:fs');
        let calls = [];
        require('node:http').createServer((req,res) => {
          let raw = '';
          req.on('data', chunk => raw += chunk);
          req.on('end', () => {
            const body = JSON.parse(raw);
            calls.push({path:req.url, model:body.model, authorized:req.headers.authorization==='Bearer routing-test-key', input:body.input});
            fs.writeFileSync('/control/codex-requests.json', JSON.stringify(calls));
            const message = {id:'msg_'+calls.length, type:'message', role:'assistant', status:'completed', content:[{type:'output_text',text:'configured-endpoint-ok',annotations:[]}]};
            const response = {id:'resp_'+calls.length,object:'response',created_at:1,status:'completed',output:[message],usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
            res.writeHead(200, {'content-type':'text/event-stream'});
            for (const event of [
              {type:'response.created',response:{...response,status:'in_progress',output:[]}},
              {type:'response.output_item.added',output_index:0,item:{...message,status:'in_progress',content:[]}},
              {type:'response.output_text.delta',output_index:0,content_index:0,item_id:message.id,delta:'configured-endpoint-ok'},
              {type:'response.output_item.done',output_index:0,item:message},
              {type:'response.completed',response}
            ]) res.write('event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n');
            res.end();
          });
        }).listen(19091,'127.0.0.1',()=>fs.writeFileSync('/control/codex-fixture-ready','ready'));
      `)};
      const child = spawn('node',['-e',server],{detached:true,stdio:'ignore'}); child.unref();
    `);
    const config = withWorkspaceModelChannel("codex", { model: "fixture/provider-model" },
      { name: "internal-provider", baseUrl: "http://127.0.0.1:19091/v1", apiKey: "routing-test-key" });
    const adapter = createWorkspaceRuntimeAdapter("codex", config);
    const workspace: Workspace = { id, chatId: id, ownerEmail: "fixture@example.test", agentName: "fixture", title: "Codex routing",
      runtime: "codex", sessionId: randomUUID(), revision: 0, status: "active", createdAt: "", updatedAt: "", dueAt: "", idleTtlSeconds: 60 };
    const session: RuntimeSession = { id: workspace.sessionId, workspaceId: id, runtime: "codex", createdAt: "", updatedAt: "" };
    await dockerCall(["exec", externalId, "node", "-e", "const fs=require('node:fs'); const until=Date.now()+5000; const tick=()=>{if(fs.existsSync('/control/codex-fixture-ready'))return; if(Date.now()>until)process.exit(1);setTimeout(tick,10)};tick()"]);
    for (const prompt of ["First routing check", "Continue the routing check"]) {
      const result = await provider.execute(externalId, adapter.command(workspace, session, { kind: "task", prompt }, 30_000));
      assert.equal(result.exitCode, 0, result.stderr);
      const events = result.stdout.split("\n").flatMap(line => adapter.events(line));
      assert.ok(events.some(event => event.kind === "message" && event.text.includes("configured-endpoint-ok")), "the configured endpoint must supply the actual CLI response");
      const started = events.find(event => event.kind === "session");
      if (!session.nativeSessionId) {
        assert.ok(started?.kind === "session");
        session.nativeSessionId = started.nativeSessionId;
      } else if (started?.kind === "session") assert.equal(started.nativeSessionId, session.nativeSessionId);
    }
    const calls = JSON.parse(await dockerCall(["exec", externalId, "cat", "/control/codex-requests.json"])) as { path: string; model: string; authorized: boolean; input: unknown }[];
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.path === "/v1/responses" && call.model === config.model && call.authorized));
    assert.ok(JSON.stringify(calls[1]!.input).includes("First routing check"), "resume retains native history at the same configured endpoint");
    assert.ok(JSON.stringify(calls[1]!.input).includes("Continue the routing check"), "resume includes the follow-up prompt");
    console.log("[ok] Codex start/resume use the configured Responses endpoint and environment credential offline");
  } finally { await provider.destroy(externalId); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
