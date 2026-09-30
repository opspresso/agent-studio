import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { parseWorkspaceConfig } from "@/lib/workspaceConfig";
import { createKubernetesSandboxBackend } from "@/infrastructure/workspace/kubernetesProvider";

/** An operator explicitly names the deployed namespace; only this probe's UID handles are removed. */
async function main() {
  const settings = parseWorkspaceConfig(process.env);
  if (settings?.provider !== "kubernetes" || !process.argv.includes(`--confirm-namespace=${settings.namespace}`)) {
    throw new Error("Confirm the configured Kubernetes Workspace namespace before running a deployment check");
  }
  const backend = createKubernetesSandboxBackend({ ...settings, diskMb: 128, instance: `${settings.instance}-probe` });
  const handles = new Set<string>();
  const workspaceId = `deployment-check-${randomUUID()}`;
  async function open() {
    const { externalId } = await backend.provider.provision!(workspaceId);
    handles.add(externalId);
    const deadline = Date.now() + 600_000;
    for (;;) {
      const state = await backend.provider.inspect(externalId);
      if (state === "ready") return externalId;
      if (state !== "provisioning" || Date.now() >= deadline) throw new Error(`Probe Pod did not become ready: ${state}`);
      await delay(2000);
    }
  }
  const command = { argv: ["/bin/sh", "-eu", "-s"], timeoutMs: 30_000 };
  try {
    const first = await open();
    const result = await backend.provider.execute(first, { ...command, stdin: "test $(id -u) = 1000; test ! -e /var/run/secrets/kubernetes.io/serviceaccount/token; test ! -w /opt/workspace/control.mjs; test ! -r /control/operations; printf deployment-check > continuity; echo isolation-ok" });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /isolation-ok/);
    const dns = await backend.provider.execute(first, { ...command, stdin: `node -e '
      const dns=require("node:dns"),net=require("node:net");
      dns.lookup("kubernetes.default.svc.cluster.local",(error,address)=>{
        if(error)process.exit(2);
        const socket=net.connect({host:address,port:443});
        socket.setTimeout(3000);socket.on("connect",()=>process.exit(1));
        socket.on("timeout",()=>process.exit(0));socket.on("error",()=>process.exit(0));
      });'` });
    assert.equal(dns.exitCode, 0, "DNS must work and the API network path must be blocked inside the Sandbox");
    const operation = "probe-operation";
    const task = { ...command, stdin: "echo operation-started; sleep 25" };
    await backend.provider.start(first, operation, task);
    await backend.provider.start(first, operation, task);
    for (let i = 0; i < 50 && (await backend.provider.operation(first, operation)).status !== "running"; i++) await delay(100);
    assert.equal((await backend.provider.operation(first, operation)).status, "running");
    await backend.provider.cancel(first, operation);
    for (let i = 0; i < 50 && (await backend.provider.operation(first, operation)).status !== "failed"; i++) await delay(100);
    assert.equal((await backend.provider.operation(first, operation)).status, "failed");
    const checkpoint = await backend.provider.checkpoint(first);
    await backend.provider.destroy(first);
    const restored = await open();
    assert.notEqual(restored, first);
    await backend.provider.destroy(first);
    await backend.provider.restore(restored, checkpoint);
    assert.equal((await backend.provider.execute(restored, { ...command, stdin: "cat continuity" })).stdout, "deployment-check");
    assert.equal((await backend.provider.operation(restored, operation)).status, "not-started");
    console.log("PASS deployed Workspace: UID/token/root isolation, DNS/network isolation, idempotency, cancel, checkpoint/restore and stale-handle fencing");
  } finally {
    for (const handle of handles) await backend.provider.destroy(handle);
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Deployment check failed"); process.exitCode = 1; });
