import { beforeEach, describe, expect, it, vi } from "vitest";
import type { V1Pod } from "@kubernetes/client-node";
import { createKubernetesSandboxBackend } from "@/infrastructure/workspace/kubernetesProvider";
import type { KubernetesSandboxApi } from "@/infrastructure/workspace/kubernetesApi";
import { routeSandboxBackend } from "@/infrastructure/workspace/backendRouting";
import { createControlledSandboxBackend, type SandboxControl } from "@/infrastructure/workspace/sandboxBackend";

const config = { image: "workspace:test", namespace: "studio-workspaces", instance: "studio-prod", memoryMb: 1024, diskMb: 2048, cpus: 1,
  nodePool: "workspaces", imagePullSecret: "ecr-registry" };
const time = Date.parse("2026-09-30T00:00:00Z");
let pod: V1Pod | null;
let api: KubernetesSandboxApi;
beforeEach(() => {
  pod = null;
  api = { get: vi.fn(async () => pod), create: vi.fn(async (spec: V1Pod): Promise<V1Pod> => {
    pod = { ...spec, metadata: { ...spec.metadata, uid: "uid-1", creationTimestamp: new Date(time - 700_000) },
      status: { phase: "Running", containerStatuses: [{ name: "sandbox", image: config.image, imageID: "digest", ready: true, restartCount: 0, state: { running: {} } }] } };
    return pod!;
  }), remove: vi.fn(async () => { pod = null; }), list: vi.fn(async () => ({ items: pod ? [pod] : [] })),
    exec: vi.fn(async () => JSON.stringify({ ready: true })) };
});
const backend = () => createKubernetesSandboxBackend(config, { api, now: () => time, sleep: async () => {} });

describe("Kubernetes Sandbox lifecycle and security", () => {
  it("adopts one workspace Pod and keeps the root supervisor isolated from the workload", async () => {
    const current = backend();
    const first = await current.provider.ensure("workspace-1");
    expect(await current.provider.ensure("workspace-1")).toEqual(first);
    expect(api.create).toHaveBeenCalledTimes(1);
    const spec = vi.mocked(api.create).mock.calls[0]![0].spec!;
    expect(spec).toMatchObject({ restartPolicy: "Never", automountServiceAccountToken: false, enableServiceLinks: false,
      serviceAccountName: "sandbox", nodeSelector: { "karpenter.sh/nodepool": "workspaces" } });
    expect(spec.volumes).toEqual([{ name: "workspace", emptyDir: { sizeLimit: "2048Mi" } },
      { name: "control", emptyDir: { sizeLimit: "2048Mi" } }, { name: "tmp", emptyDir: { sizeLimit: "256Mi" } }]);
    expect(spec.containers).toHaveLength(1);
    expect(spec.containers[0]).toMatchObject({ securityContext: { runAsUser: 0, allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"], add: ["SETUID", "SETGID", "CHOWN", "FOWNER", "DAC_OVERRIDE", "KILL"] } },
      resources: { requests: { cpu: "1", memory: "1024Mi", "ephemeral-storage": "4608Mi" }, limits: { "ephemeral-storage": "4608Mi" } } });
    expect(spec.containers[0]?.env).toEqual([{ name: "WORKSPACE_POD_UID", valueFrom: { fieldRef: { fieldPath: "metadata.uid" } } }]);
    expect(await current.provider.inspect(first.externalId)).toBe("ready");
  });
  it("passes identity and task input over stdin and serializes privileged Git and checkpoint access", async () => {
    const current = backend();
    const { externalId } = await current.provider.ensure("workspace-1");
    const command = { argv: ["sh"], stdin: "echo private-task", environment: { OPENAI_API_KEY: "fixture-secret" }, timeoutMs: 1000 };
    await current.provider.start(externalId, "run-1", command);
    const [, argv, input] = vi.mocked(api.exec).mock.calls.at(-1)!;
    expect(argv).toEqual(["node", "/opt/workspace/control.mjs", "start"]);
    expect(argv.join(" ")).not.toContain("fixture-secret");
    expect(JSON.parse(input)).toEqual({ id: "run-1", command, podUid: "uid-1" });
    await current.control(externalId, "git-review", {});
    expect(vi.mocked(api.exec).mock.calls.at(-1)![1]).toEqual(["flock", "-w", "2", "/control/git.flock", "node", "/opt/workspace/control.mjs", "git-review"]);
  });
  it("fences replacement UIDs for commands and deletion, and deletes with the current UID precondition", async () => {
    const current = backend();
    const { externalId } = await current.provider.ensure("workspace-1");
    await current.provider.destroy(externalId);
    expect(api.remove).toHaveBeenCalledWith(expect.any(String), "uid-1");
    await current.provider.ensure("workspace-1");
    pod!.metadata!.uid = "uid-2";
    expect(await current.provider.inspect(externalId)).toBe("missing");
    await current.provider.destroy(externalId);
    expect(api.remove).toHaveBeenCalledTimes(1);
    await expect(current.provider.cancel(externalId, "run-1")).rejects.toThrow("not running");
  });
  it("distinguishes API transport failure, terminal eviction and absence without recreating uncertain compute", async () => {
    const current = backend();
    const { externalId } = await current.provider.ensure("workspace-1");
    vi.mocked(api.get).mockRejectedValueOnce(new Error("API unreachable"));
    await expect(current.provider.inspect(externalId)).rejects.toThrow("API unreachable");
    pod!.status = { phase: "Failed", reason: "Evicted" };
    expect(await current.provider.inspect(externalId)).toBe("stopped");
    pod = null;
    expect(await current.provider.inspect(externalId)).toBe("missing");
    expect(api.create).toHaveBeenCalledTimes(1);
  });
  it("waits for deletion before returning so restoration cannot race a terminating Pod", async () => {
    let clock = time;
    const pause = vi.fn(async (ms: number) => { clock += ms; });
    const current = createKubernetesSandboxBackend(config, { api, now: () => clock, sleep: pause });
    const { externalId } = await current.provider.ensure("workspace-1");
    let deleting = false;
    let reads = 0;
    vi.mocked(api.remove).mockImplementation(async () => { deleting = true; });
    vi.mocked(api.get).mockImplementation(async () => {
      if (deleting && ++reads === 3) pod = null;
      return pod;
    });
    await current.provider.destroy(externalId);
    expect(pause).toHaveBeenCalledTimes(2);
    expect(await current.provider.inspect(externalId)).toBe("missing");
  });
  it("replaces an owned terminal Pod whose provisioning handle never reached storage", async () => {
    const current = backend();
    await current.provider.ensure("workspace-1");
    pod!.status = { phase: "Failed", reason: "Evicted" };
    await current.provider.ensure("workspace-1");
    expect(api.remove).toHaveBeenCalledTimes(1);
    expect(api.create).toHaveBeenCalledTimes(2);
  });
  it("does not adopt another installation or a changed image", async () => {
    await backend().provider.ensure("workspace-1");
    pod!.metadata!.labels!["agent-studio/instance"] = "other-studio";
    await expect(backend().provider.ensure("workspace-1")).rejects.toThrow("ownership");
    expect(api.remove).not.toHaveBeenCalled();
  });
  it("preserves capacity and transport errors; only a create conflict may be adopted", async () => {
    vi.mocked(api.create).mockRejectedValueOnce({ code: 403 });
    await expect(backend().provider.ensure("workspace-1")).rejects.toEqual({ code: 403 });
    expect(api.get).toHaveBeenCalledTimes(1);
  });
  it("sweeps one page of confirmed orphans while retaining recent resources and DB failures", async () => {
    const current = backend();
    const { externalId } = await current.provider.ensure("workspace-1");
    const keep = vi.fn(async () => true);
    expect(await current.sweepOrphans(keep)).toBe(0);
    expect(keep).toHaveBeenCalledWith("workspace-1", externalId);
    pod!.metadata!.creationTimestamp = new Date(time);
    expect(await current.sweepOrphans(async () => false)).toBe(0);
    pod!.metadata!.creationTimestamp = new Date(time - 700_000);
    await expect(current.sweepOrphans(async () => { throw new Error("DB unavailable"); })).rejects.toThrow("DB unavailable");
    expect(api.remove).not.toHaveBeenCalled();
    expect(await current.sweepOrphans(async () => false)).toBe(1);
    expect(api.remove).toHaveBeenCalledWith(expect.any(String), "uid-1");
  });
});

describe("Sandbox migration routing", () => {
  it("observes and cleans up old Docker handles through Docker while provisioning new work through Kubernetes", async () => {
    const current = backend();
    const dockerId = "a".repeat(64);
    const controlCalls = vi.fn();
    const legacyControl: SandboxControl = async <T>(...args: Parameters<SandboxControl>) => { controlCalls(...args); return { status: "running" } as T; };
    const lifecycle = { ensure: vi.fn(async () => ({ externalId: dockerId })), inspect: vi.fn(async () => "ready" as const), destroy: vi.fn(async () => {}) };
    const legacy = createControlledSandboxBackend("docker", lifecycle, legacyControl);
    const routed = routeSandboxBackend(current, legacy);
    await routed.provider.operation(dockerId, "old-run");
    await routed.control(dockerId, "git-review", {});
    await routed.provider.destroy(dockerId);
    expect(controlCalls).toHaveBeenCalledTimes(2);
    expect(lifecycle.destroy).toHaveBeenCalledWith(dockerId);
    expect((await routed.provider.ensure("new-workspace")).externalId).toMatch(/^k8s:/);
    expect(lifecycle.ensure).not.toHaveBeenCalled();
    expect(() => routeSandboxBackend(current).provider.destroy(dockerId)).toThrow("retain legacy Docker");
  });
});
