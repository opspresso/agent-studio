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
  if (!page.items.some(pod => !["Failed", "Succeeded"].includes(pod.status?.phase ?? ""))) return;
  // A disconnected daemon throws; it must never be interpreted as an empty inventory.
  if ((await containers()).trim()) throw new SandboxProviderError("Legacy Docker workspaces remain; checkpoint and close them before cutover");
}
