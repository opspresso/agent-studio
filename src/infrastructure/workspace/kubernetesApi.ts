import { CoreV1Api, Exec, KubeConfig, createConfiguration, type V1Pod, type V1PodList } from "@kubernetes/client-node";
import { Readable, Writable } from "node:stream";
import { SandboxProviderError } from "./sandboxBackend";

/** Only namespaced Pod operations; no Secrets, nodes, workloads or PVC access. */
export interface KubernetesSandboxApi {
  get(name: string): Promise<V1Pod | null>;
  create(pod: V1Pod): Promise<V1Pod>;
  remove(name: string, uid: string): Promise<void>;
  list(selector: string, cursor?: string): Promise<V1PodList>;
  exec(name: string, argv: string[], input: string, maxBytes: number): Promise<string>;
}

export function kubernetesStatusCode(error: unknown): number | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "number" ? error.code : undefined;
}

export function createKubernetesSandboxApi(namespace: string, context?: string, configuration?: KubeConfig): KubernetesSandboxApi {
  // Loading credentials is deferred until Workspace actually uses this backend.
  let connection: { core: CoreV1Api; exec: Exec } | undefined;
  const clients = () => {
    if (!connection) {
      const kube = configuration ?? new KubeConfig();
      if (!configuration) {
        if (context) { kube.loadFromDefault(); kube.setCurrentContext(context); }
        else kube.loadFromCluster();
      }
      connection = { core: kube.makeApiClient(CoreV1Api), exec: new Exec(kube) };
    }
    return connection;
  };
  const options = () => ({ middlewareMergeStrategy: "append" as const, middleware: createConfiguration({ promiseMiddleware: [{
    pre: async request => { request.setSignal(AbortSignal.timeout(30_000)); return request; },
    post: async response => response,
  }] }).middleware });
  return {
    async get(name) {
      try { return await clients().core.readNamespacedPod({ namespace, name }, options()); }
      catch (error) { if (kubernetesStatusCode(error) === 404) return null; throw error; }
    },
    create: pod => clients().core.createNamespacedPod({ namespace, body: pod }, options()),
    async remove(name, uid) {
      try { await clients().core.deleteNamespacedPod({ namespace, name,
        body: { preconditions: { uid }, gracePeriodSeconds: 30 } }, options()); }
      catch (error) { if (kubernetesStatusCode(error) !== 404) throw error; }
    },
    list: (selector, cursor) => clients().core.listNamespacedPod({ namespace, labelSelector: selector, limit: 50,
      ...(cursor ? { _continue: cursor } : {}) }, options()),
    exec(name, argv, input, maxBytes) {
      const executor = clients().exec;
      return new Promise((resolve, reject) => {
        let socket: Awaited<ReturnType<Exec["exec"]>> | undefined;
        let settled = false;
        let bytes = 0;
        const chunks: Buffer[] = [];
        const stdin = new Readable({ read() {} });
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          stdin.destroy();
          socket?.terminate();
          if (error) reject(error); else resolve(Buffer.concat(chunks).toString("utf8"));
        };
        const timer = setTimeout(() => finish(new SandboxProviderError("Kubernetes Sandbox control deadline exceeded")), 120_000);
        const stdout = new Writable({ write(chunk: Buffer, _encoding, done) {
          bytes += chunk.length;
          if (bytes > maxBytes) finish(new SandboxProviderError("Sandbox response exceeded its byte limit"));
          else chunks.push(Buffer.from(chunk));
          done();
        } });
        // Control failure details can contain submitted input; do not surface them.
        const stderr = new Writable({ write(_chunk, _encoding, done) { done(); } });
        executor.exec(namespace, name, "sandbox", argv, stdout, stderr, stdin, false, status => {
          finish(status.status === "Success" ? undefined : new SandboxProviderError("Kubernetes Sandbox control command failed"));
        }).then(opened => {
          socket = opened;
          if (settled) { socket.terminate(); return; }
          socket.on("error", () => finish(new SandboxProviderError("Kubernetes Sandbox control transport failed")));
          socket.on("close", () => finish(new SandboxProviderError("Kubernetes Sandbox control connection ended without a result")));
          if (socket.protocol !== "v5.channel.k8s.io") {
            finish(new SandboxProviderError("Kubernetes Sandbox requires exec protocol v5 (Kubernetes 1.31+)"));
            return;
          }
          const data = Buffer.from(input);
          for (let offset = 0; offset < data.length; offset += 32_000) stdin.push(data.subarray(offset, offset + 32_000));
          stdin.push(null);
        }).catch(() => finish(new SandboxProviderError("Unable to connect to Kubernetes Sandbox control")));
      });
    },
  };
}
