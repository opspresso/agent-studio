import { dockerCall } from "./dockerProvider";
import type { KubernetesSandboxApi } from "./kubernetesApi";
import { SandboxProviderError } from "./sandboxBackend";

/** Cutover may recreate the old DinD Pod only after every workspace container is drained. */
export async function assertLegacyDockerDrained(
  api: Pick<KubernetesSandboxApi, "list">,
  instance: string,
  containers: () => Promise<string> = () => dockerCall(["container", "ls", "-aq", "--filter", "label=agent-studio.workspace=true"]),
): Promise<void> {
  const page = await api.list(`app.kubernetes.io/instance=${instance},app.kubernetes.io/name in (agent-studio-workspace-worker,agent-studio-workspace-docker)`);
  if (page.metadata?._continue) throw new SandboxProviderError("Legacy Sandbox inventory exceeds the migration check bound");
  const legacyPresent = page.items.some(pod => {
    if (["Failed", "Succeeded"].includes(pod.status?.phase ?? "")) return false;
    // The worker name survives cutover. Only its Docker sidecar belongs to the
    // old backend; a Kubernetes-only worker must not require a retired daemon.
    if (pod.metadata?.labels?.["app.kubernetes.io/name"] === "agent-studio-workspace-worker" && pod.spec?.containers.length) {
      return [...pod.spec.containers, ...(pod.spec.initContainers ?? [])].some(container => container.name === "docker");
    }
    // Dedicated daemon Pods and incomplete inventory still require a Docker read.
    return true;
  });
  if (!legacyPresent) return;
  // A disconnected daemon throws; it must never be interpreted as an empty inventory.
  if ((await containers()).trim()) throw new SandboxProviderError("Legacy Docker workspaces remain; checkpoint and close them before cutover");
}
