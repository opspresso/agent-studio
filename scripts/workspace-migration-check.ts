import { createKubernetesSandboxApi } from "@/infrastructure/workspace/kubernetesApi";
import { assertLegacyDockerDrained } from "@/infrastructure/workspace/migrationGuard";
import { log } from "@/shared/logger";

async function main() {
  const namespace = process.env.WORKSPACE_CONTROL_NAMESPACE;
  const instance = process.env.WORKSPACE_INSTANCE;
  if (!namespace || !instance || !/^[a-z0-9-]{1,63}$/.test(namespace) || !/^[a-z0-9-]{1,63}$/.test(instance)) {
    throw new Error("Workspace migration identity is missing");
  }
  await assertLegacyDockerDrained(createKubernetesSandboxApi(namespace), instance);
  log.info("workspace-worker", "Legacy Docker workspaces are drained; cutover may proceed");
}
main().catch(() => {
  log.error("workspace-worker", "Cutover blocked: verify the legacy Docker daemon and checkpoint/close all legacy workspaces");
  process.exitCode = 1;
});
