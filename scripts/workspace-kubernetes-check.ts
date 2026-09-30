import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CoreV1Api, KubeConfig, NetworkingV1Api, RbacAuthorizationV1Api, AuthorizationV1Api, loadAllYaml,
  type V1NetworkPolicy, type V1ResourceQuota, type V1Role, type V1RoleBinding } from "@kubernetes/client-node";
import { createKubernetesSandboxBackend } from "@/infrastructure/workspace/kubernetesProvider";
import { createKubernetesSandboxApi } from "@/infrastructure/workspace/kubernetesApi";

/** Runs only on a disposable loopback cluster; never uses the current production context. */
async function main() {
  const context = process.env.WORKSPACE_KUBERNETES_TEST_CONTEXT;
  if (!context) throw new Error("WORKSPACE_KUBERNETES_TEST_CONTEXT is required");
  const kube = new KubeConfig(); kube.loadFromDefault(); kube.setCurrentContext(context);
  const host = new URL(kube.getCurrentCluster()!.server).hostname;
  if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) throw new Error("Kubernetes checks require a disposable loopback cluster");
  const api = kube.makeApiClient(CoreV1Api);
  const namespace = `studio-workspace-test-${randomUUID().slice(0, 8)}`;
  let created = false;
  const image = process.env.WORKSPACE_SANDBOX_IMAGE || "agent-studio-workspace:kubernetes-check";
  const config = { namespace, instance: "test", image, memoryMb: 1024, diskMb: 128, cpus: 1, kubeContext: context };
  let backend = createKubernetesSandboxBackend(config);
  const manifestPath = process.env.WORKSPACE_KUBERNETES_TEST_MANIFEST;
  const networking = kube.makeApiClient(NetworkingV1Api);
  try {
    await api.createNamespace({ body: { metadata: { name: namespace, labels: { "pod-security.kubernetes.io/enforce": "baseline" } } } }); created = true;
    await api.createNamespacedServiceAccount({ namespace, body: { metadata: { name: "sandbox" }, automountServiceAccountToken: false } });
    const documents = manifestPath ? loadAllYaml(await readFile(manifestPath, "utf8")) as (V1NetworkPolicy | V1ResourceQuota | V1Role | V1RoleBinding)[] : [];
    const fixture = documents.filter(doc => doc?.metadata?.namespace === "agent-studio-workspaces");
    if (manifestPath) {
      const rbac = kube.makeApiClient(RbacAuthorizationV1Api);
      await api.createNamespacedServiceAccount({ namespace, body: { metadata: { name: "agent-studio" } } });
      for (const doc of fixture) {
        doc.metadata = { ...doc.metadata, namespace };
        if (doc.kind === "Role") await rbac.createNamespacedRole({ namespace, body: doc as V1Role });
        if (doc.kind === "RoleBinding") {
          const binding = doc as V1RoleBinding;
          binding.subjects = [{ kind: "ServiceAccount", namespace, name: "agent-studio" }];
          await rbac.createNamespacedRoleBinding({ namespace, body: binding });
        }
      }
      const token = await api.createNamespacedServiceAccountToken({ namespace, name: "agent-studio", body: { spec: { audiences: ["https://kubernetes.default.svc.cluster.local"], expirationSeconds: 600 } } });
      const scoped = new KubeConfig(); scoped.loadFromClusterAndUser(kube.getCurrentCluster()!, { name: "controller", token: token.status!.token });
      const authorization = scoped.makeApiClient(AuthorizationV1Api);
      for (const [resource, verb, target, allowed] of [["pods", "create", namespace, true], ["pods", "create", "default", false], ["secrets", "get", namespace, false], ["nodes", "get", "", false]] as const) {
        const review = await authorization.createSelfSubjectAccessReview({ body: { spec: { resourceAttributes: { resource, verb, namespace: target } } } });
        assert.equal(review.status?.allowed, allowed, `${verb} ${resource} namespace=${target}`);
      }
      backend = createKubernetesSandboxBackend(config, { api: createKubernetesSandboxApi(namespace, undefined, scoped) });
    }
    const first = await backend.provider.ensure("workspace-1");
    const command = { argv: ["/bin/sh", "-eu", "-s"], timeoutMs: 30_000 };
    const result = await backend.provider.execute(first.externalId, { ...command,
      stdin: "test $(id -u) = 1000; test ! -e /var/run/secrets/kubernetes.io/serviceaccount/token; printf continuity > file; mkdir -p /workspace/home/.codex/sessions; printf native-history > /workspace/home/.codex/sessions/fixture; echo pod-ok" });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /pod-ok/);
    if (manifestPath) {
      const peer = await api.createNamespacedPod({ namespace, body: { metadata: { name: "peer" }, spec: {
        automountServiceAccountToken: false, restartPolicy: "Never", containers: [{ name: "peer", image, imagePullPolicy: "IfNotPresent",
          command: ["node", "-e", "require('node:http').createServer((q,r)=>r.end('peer-ok')).listen(8000)"],
          securityContext: { runAsUser: 1000, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
          resources: { requests: { cpu: "100m", memory: "64Mi", "ephemeral-storage": "16Mi" }, limits: { cpu: "100m", memory: "64Mi", "ephemeral-storage": "16Mi" } },
          readinessProbe: { httpGet: { path: "/", port: 8000 }, periodSeconds: 1 },
        }] } } });
      let peerIp: string | undefined;
      for (let attempt = 0; attempt < 60; attempt++) {
        const current = await api.readNamespacedPod({ namespace, name: "peer" });
        if (current.status?.containerStatuses?.[0]?.ready) { peerIp = current.status.podIP; break; }
        await delay(500);
      }
      assert.ok(peerIp, "Peer fixture must be serving before checking isolation");
      const probe = () => backend.provider.execute(first.externalId, { ...command, stdin: `curl -fsS --max-time 1 http://${peerIp}:8000/` });
      assert.equal((await probe()).stdout, "peer-ok");
      for (const doc of fixture) {
        if (doc.kind === "NetworkPolicy") await networking.createNamespacedNetworkPolicy({ namespace, body: doc as V1NetworkPolicy });
        if (doc.kind === "ResourceQuota") await api.createNamespacedResourceQuota({ namespace, body: doc as V1ResourceQuota });
      }
      let blocked = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        if ((await probe()).exitCode !== 0) { blocked = true; break; }
        await delay(500);
      }
      assert.ok(blocked, "Shipped NetworkPolicy must block a known reachable private peer");
      const dns = await backend.provider.execute(first.externalId, { ...command,
        stdin: "node -e \"require('node:dns').lookup('kubernetes.default.svc.cluster.local',e=>process.exit(e?1:0))\"" });
      assert.equal(dns.exitCode, 0, "Shipped DNS policy must allow cluster DNS");
      for (let attempt = 0; attempt < 30; attempt++) {
        const quota = await api.readNamespacedResourceQuota({ namespace, name: "agent-studio-sandbox" });
        if (quota.status?.used?.pods === "2") break;
        await delay(500);
      }
      await assert.rejects(backend.provider.ensure("over-quota"), error => (error as { code?: number }).code === 403);
      await api.deleteNamespacedPod({ namespace, name: "peer", body: { preconditions: { uid: peer.metadata!.uid }, gracePeriodSeconds: 0 } });
      console.log("PASS shipped k3s manifests: minimum RBAC, private peer blocking, DNS and Pod quota");
    }
    const operationId = "native-operation";
    await backend.provider.start(first.externalId, operationId, { ...command, stdin: "echo started; sleep 30" });
    await backend.provider.start(first.externalId, operationId, { ...command, stdin: "echo started; sleep 30" });
    for (let attempt = 0; attempt < 30; attempt++) {
      if ((await backend.provider.operation(first.externalId, operationId)).status === "running") break;
      await delay(100);
    }
    assert.equal((await backend.provider.operation(first.externalId, operationId)).status, "running");
    await backend.provider.cancel(first.externalId, operationId);
    for (let attempt = 0; attempt < 30; attempt++) {
      if ((await backend.provider.operation(first.externalId, operationId)).status === "failed") break;
      await delay(100);
    }
    assert.equal((await backend.provider.operation(first.externalId, operationId)).status, "failed");
    assert.match((await backend.provider.output(first.externalId, operationId, 0)).frames.map(frame => frame.text).join(""), /started/);
    const checkpoint = await backend.provider.checkpoint(first.externalId);
    const name = first.externalId.split(":")[2]!;
    const uid = first.externalId.split(":")[3]!;
    await backend.provider.destroy(first.externalId);
    for (let attempt = 0; attempt < 60; attempt++) {
      try { await api.readNamespacedPod({ namespace, name }); }
      catch (error) { if ((error as { code?: number }).code === 404) break; throw error; }
      await delay(500);
    }
    assert.equal(await backend.provider.inspect(first.externalId), "missing");
    const second = await backend.provider.ensure("workspace-1");
    assert.notEqual(second.externalId.split(":")[3], uid);
    await backend.provider.destroy(first.externalId); // A stale handle must leave the replacement alive.
    assert.equal(await backend.provider.inspect(second.externalId), "ready");
    await backend.provider.restore(second.externalId, checkpoint);
    const restored = await backend.provider.execute(second.externalId, { ...command, stdin: "cat file /workspace/home/.codex/sessions/fixture" });
    assert.equal(restored.exitCode, 0, restored.stderr);
    assert.equal(restored.stdout, "continuitynative-history");
    if (manifestPath) {
      await backend.provider.start(second.externalId, "disk-overflow", { ...command, timeoutMs: 240_000,
        stdin: "head -c 268435456 /dev/zero > disk-overflow; sleep 240" });
      let evicted = false;
      let lastStatus = "";
      // Kubelet volume stats default to 1 minute. Allow two collection cycles plus Pod termination/reporting.
      for (let attempt = 0; attempt < 180; attempt++) {
        const current = await api.readNamespacedPod({ namespace, name });
        lastStatus = `${current.status?.phase}: ${current.status?.reason ?? ""} ${current.status?.message ?? ""}`;
        if (current.status?.phase === "Failed" && current.status.reason === "Evicted") {
          assert.match(current.status.message ?? "", /EmptyDir.*workspace.*exceeds/i);
          evicted = true; break;
        }
        await delay(1000);
      }
      assert.ok(evicted, `Kubelet must evict a Pod exceeding its emptyDir limit: ${lastStatus}`);
      assert.equal(await backend.provider.inspect(second.externalId), "stopped");
      await backend.provider.destroy(second.externalId);
      const recovered = await backend.provider.ensure("workspace-1");
      await backend.provider.restore(recovered.externalId, checkpoint);
      assert.equal((await backend.provider.operation(recovered.externalId, "disk-overflow")).status, "not-started");
      const data = await backend.provider.execute(recovered.externalId, { ...command, stdin: "cat file /workspace/home/.codex/sessions/fixture" });
      assert.equal(data.stdout, "continuitynative-history");
      console.log("PASS real disk eviction: stopped compute, checkpoint recovery and no operation replay");
      const nodeContainer = process.env.WORKSPACE_KUBERNETES_TEST_NODE_CONTAINER;
      if (nodeContainer) {
        if (!/^studio-k8s-check-[a-z0-9-]+$/.test(nodeContainer)) throw new Error("Node failure checks require an owned studio-k8s-check-* container");
        const docker = promisify(execFile);
        const { stdout: nodeImage } = await docker("docker", ["inspect", "--format", "{{.Config.Image}}", nodeContainer]);
        assert.match(nodeImage.trim(), /^rancher\/k3s:/);
        await backend.provider.start(recovered.externalId, "node-failure", { ...command, timeoutMs: 120_000, stdin: "echo node-started; sleep 120" });
        await docker("docker", ["restart", nodeContainer], { timeout: 120_000 });
        let lost = false;
        for (let attempt = 0; attempt < 120; attempt++) {
          try {
            const status = await backend.provider.inspect(recovered.externalId);
            if (status !== "ready" || (await backend.provider.operation(recovered.externalId, "node-failure")).status === "missing") { lost = true; break; }
          } catch { /* API unavailability does not prove native execution was lost. */ }
          await delay(1000);
        }
        assert.ok(lost, "The stopped node must expose stopped compute or a lost operation handle");
        await backend.provider.destroy(recovered.externalId);
        const resumed = await backend.provider.ensure("workspace-1");
        await backend.provider.restore(resumed.externalId, checkpoint);
        assert.equal((await backend.provider.operation(resumed.externalId, "node-failure")).status, "not-started");
        const data = await backend.provider.execute(resumed.externalId, { ...command, stdin: "cat file /workspace/home/.codex/sessions/fixture" });
        assert.equal(data.stdout, "continuitynative-history");
        console.log("PASS local node restart: uncertain transport retained, lost operation detected and prior checkpoint restored");
      }
    }
    console.log("PASS Kubernetes: root/uid isolation, no token, exec v5, idempotent operation, output, cancellation, checkpoint/session restore and stale UID fencing");
  } finally {
    if (created) await api.deleteNamespace({ name: namespace });
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Kubernetes check failed"); process.exitCode = 1; });
