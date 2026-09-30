import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { V1Pod } from "@kubernetes/client-node";
import { createControlledSandboxBackend, SandboxProviderError, type SandboxControl } from "./sandboxBackend";
import { createKubernetesSandboxApi, kubernetesStatusCode, type KubernetesSandboxApi } from "./kubernetesApi";

export interface KubernetesSandboxConfig {
  image: string;
  namespace: string;
  instance: string;
  memoryMb: number;
  diskMb: number;
  cpus: number;
  kubeContext?: string;
  nodePool?: string;
  imagePullSecret?: string;
}

const ownerKey = "agent-studio/instance";
const workspaceKey = "agent-studio/workspace-id";
const orphanGraceMs = 10 * 60_000;

/** The request UID is checked again inside the root supervisor, fencing exec name-reuse races. */
export function createKubernetesSandboxBackend(config: KubernetesSandboxConfig, dependencies: {
  api?: KubernetesSandboxApi;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
} = {}) {
  const dnsName = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
  if (![config.namespace, config.instance, ...(config.nodePool ? [config.nodePool] : []), ...(config.imagePullSecret ? [config.imagePullSecret] : [])]
    .every(value => value.length <= 63 && dnsName.test(value)) || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,300}$/.test(config.image) ||
    !Number.isInteger(config.memoryMb) || config.memoryMb < 128 || config.memoryMb > 65536 ||
    !Number.isInteger(config.diskMb) || config.diskMb < 64 || config.diskMb > 65536 ||
    !Number.isFinite(config.cpus) || config.cpus < 0.1 || config.cpus > 64) throw new SandboxProviderError("Invalid Kubernetes sandbox configuration");
  const api = dependencies.api ?? createKubernetesSandboxApi(config.namespace, config.kubeContext);
  const now = dependencies.now ?? Date.now;
  const pause = dependencies.sleep ?? sleep;
  const selector = `${ownerKey}=${config.instance},app.kubernetes.io/name=agent-studio-sandbox`;
  const handle = (pod: V1Pod) => {
    if (!pod.metadata?.name || !pod.metadata.uid) throw new SandboxProviderError("Kubernetes Sandbox identity is missing");
    return `k8s:${config.namespace}:${pod.metadata.name}:${pod.metadata.uid}`;
  };
  const identity = (id: string) => {
    const parts = /^k8s:([a-z0-9-]+):([a-z0-9-]+):([a-z0-9-]+)$/.exec(id);
    if (!parts || parts[1] !== config.namespace) throw new SandboxProviderError("Invalid Kubernetes Sandbox handle");
    return { name: parts[2]!, uid: parts[3]! };
  };
  const owned = (pod: V1Pod) => {
    if (pod.metadata?.labels?.[ownerKey] !== config.instance || pod.metadata.labels["app.kubernetes.io/name"] !== "agent-studio-sandbox") {
      throw new SandboxProviderError("Kubernetes Sandbox ownership mismatch");
    }
  };
  const lookup = async (id: string) => {
    const { name, uid } = identity(id);
    const pod = await api.get(name);
    if (!pod || pod.metadata?.uid !== uid) return null;
    owned(pod);
    return pod;
  };
  const ready = (pod: V1Pod) => !pod.metadata?.deletionTimestamp && pod.status?.phase === "Running" &&
    pod.status.containerStatuses?.some(container => container.name === "sandbox" && container.ready && container.state?.running);
  const control: SandboxControl = async <T>(id: string, action: string, request: unknown, maxBytes = 1024 * 1024) => {
    const pod = await lookup(id);
    if (!pod || !ready(pod)) throw new SandboxProviderError("Kubernetes Sandbox is not running");
    const lock = action.startsWith("git-") || action === "checkpoint" || action === "restore" ? ["flock", "-w", "2", "/control/git.flock"] : [];
    const result = await api.exec(pod.metadata!.name!, [...lock, "node", "/opt/workspace/control.mjs", action],
      JSON.stringify({ ...(request as object), podUid: pod.metadata!.uid }), maxBytes);
    return JSON.parse(result) as T;
  };
  const backend = createControlledSandboxBackend("kubernetes", {
    async ensure(workspaceId) {
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(workspaceId)) throw new SandboxProviderError("Invalid workspace id");
      const name = `studio-ws-${createHash("sha256").update(workspaceId).digest("hex").slice(0,40)}`;
      let pod = await api.get(name);
      if (pod) {
        owned(pod);
        if (pod.metadata?.annotations?.[workspaceKey] !== workspaceId || pod.spec?.containers?.length !== 1 ||
          pod.spec.containers[0]?.image !== config.image) throw new SandboxProviderError("Existing Kubernetes Sandbox configuration mismatch");
        // Provisioning may have ended before its handle reached the DB. Only terminal owned compute is replaceable.
        if (["Failed", "Succeeded"].includes(pod.status?.phase ?? "")) {
          await backend.provider.destroy(handle(pod));
          pod = null;
        }
      }
      if (!pod) {
        const disk = `${config.diskMb}Mi`;
        // Requests cover both emptyDirs, tmp and log headroom; image cache is node-owned.
        const storage = `${config.diskMb * 2 + 512}Mi`;
        const resources = { cpu: String(config.cpus), memory: `${config.memoryMb}Mi`, "ephemeral-storage": storage };
        const spec: V1Pod = { apiVersion: "v1", kind: "Pod", metadata: { name, namespace: config.namespace,
          labels: { "app.kubernetes.io/name": "agent-studio-sandbox", [ownerKey]: config.instance },
          annotations: { [workspaceKey]: workspaceId, "sidecar.istio.io/inject": "false" } }, spec: {
          restartPolicy: "Never", terminationGracePeriodSeconds: 30, serviceAccountName: "sandbox", automountServiceAccountToken: false,
          enableServiceLinks: false,
          ...(config.imagePullSecret ? { imagePullSecrets: [{ name: config.imagePullSecret }] } : {}),
          ...(config.nodePool ? { nodeSelector: { "karpenter.sh/nodepool": config.nodePool },
            tolerations: [{ key: "agent-studio/workspace", operator: "Equal", value: "true", effect: "NoSchedule" }] } : {}),
          securityContext: { seccompProfile: { type: "RuntimeDefault" } },
          volumes: [{ name: "workspace", emptyDir: { sizeLimit: disk } }, { name: "control", emptyDir: { sizeLimit: disk } },
            { name: "tmp", emptyDir: { sizeLimit: "256Mi" } }],
          containers: [{ name: "sandbox", image: config.image, imagePullPolicy: "IfNotPresent",
            command: ["tini", "-s", "--", "prlimit", "--nproc=256", "--", "node", "/opt/workspace/control.mjs", "serve"],
            env: [{ name: "WORKSPACE_POD_UID", valueFrom: { fieldRef: { fieldPath: "metadata.uid" } } }],
            securityContext: { runAsUser: 0, runAsGroup: 0, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true,
              capabilities: { drop: ["ALL"], add: ["SETUID", "SETGID", "CHOWN", "FOWNER", "DAC_OVERRIDE", "KILL"] } },
            resources: { requests: resources, limits: resources },
            volumeMounts: [{ name: "workspace", mountPath: "/workspace" }, { name: "control", mountPath: "/control" }, { name: "tmp", mountPath: "/tmp" }],
            readinessProbe: { exec: { command: ["node", "-e", "require('node:fs').accessSync('/control/operations')"] },
              initialDelaySeconds: 1, periodSeconds: 2, timeoutSeconds: 2 },
          }],
        } };
        try { pod = await api.create(spec); }
        catch (error) {
          // Only a name conflict is safe to adopt; an uncertain API write is never replayed.
          if (kubernetesStatusCode(error) !== 409) throw error;
          pod = await api.get(name);
          if (!pod) throw error;
        }
      }
      owned(pod);
      if (pod.metadata?.annotations?.[workspaceKey] !== workspaceId || pod.spec?.containers?.length !== 1 ||
        pod.spec.containers[0]?.image !== config.image) throw new SandboxProviderError("Existing Kubernetes Sandbox configuration mismatch");
      const id = handle(pod);
      const deadline = now() + 120_000;
      while (!ready(pod)) {
        if (["Failed", "Succeeded"].includes(pod.status?.phase ?? "") || pod.metadata?.deletionTimestamp) {
          throw new SandboxProviderError(`Kubernetes Sandbox stopped (${pod.status?.reason ?? pod.status?.phase ?? "deleting"})`);
        }
        if (now() >= deadline) throw new SandboxProviderError("Kubernetes Sandbox readiness deadline exceeded");
        await pause(1000);
        const current = await lookup(id);
        if (!current) throw new SandboxProviderError("Kubernetes Sandbox disappeared during provisioning");
        pod = current;
      }
      await control(id, "ready", {});
      return { externalId: id };
    },
    async inspect(id) { const pod = await lookup(id); return !pod ? "missing" : ready(pod) ? "ready" : "stopped"; },
    async destroy(id) {
      const pod = await lookup(id);
      if (!pod) return;
      await api.remove(pod.metadata!.name!, pod.metadata!.uid!);
      const deadline = now() + 120_000;
      while (await lookup(id)) {
        if (now() >= deadline) throw new SandboxProviderError("Kubernetes Sandbox deletion deadline exceeded; compute may still be running");
        await pause(500);
      }
    },
  }, control);
  let cursor: string | undefined;
  return { ...backend,
    health: async () => { await api.list(selector); },
    /** One bounded page per sweep; DB errors leave compute untouched. */
    async sweepOrphans(keep: (workspaceId: string, externalId: string) => Promise<boolean>): Promise<number> {
      const page = await api.list(selector, cursor);
      cursor = page.metadata?._continue;
      let removed = 0;
      for (const pod of page.items) {
        owned(pod);
        const workspaceId = pod.metadata?.annotations?.[workspaceKey];
        const created = pod.metadata?.creationTimestamp?.getTime();
        if (!workspaceId || created === undefined || !Number.isFinite(created) || now() - created < orphanGraceMs) continue;
        const id = handle(pod);
        if (!await keep(workspaceId, id)) {
          const current = await lookup(id);
          if (current) { await api.remove(current.metadata!.name!, current.metadata!.uid!); removed++; }
        }
      }
      return removed;
    },
  };
}
