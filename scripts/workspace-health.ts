import { getWorkspaceConfig, getWorkspaceRuntimeConfig } from "@/lib/runtime-settings";
import { WORKSPACE_MODEL_RUNTIMES } from "@/domain/workspace/runtimeModels";
import { settingsRepository } from "@/infrastructure/db/repositories/settingsRepository";
import { createDockerSandboxBackend } from "@/infrastructure/workspace/dockerProvider";
import { createKubernetesSandboxBackend } from "@/infrastructure/workspace/kubernetesProvider";
import { closePool } from "@/infrastructure/db/client";
import { assertWorkspaceHeartbeat } from "./workspace-heartbeat";

let stage = "configuration";
async function checkHeartbeat() {
  stage = "worker heartbeat";
  await assertWorkspaceHeartbeat();
}
async function main() {
  // Liveness must not restart a worker because a shared dependency is down.
  if (process.argv.includes("--heartbeat-only")) {
    await checkHeartbeat();
    console.log("OK Workspace worker heartbeat");
    return;
  }
  const config = getWorkspaceConfig();
  if (!config) throw new Error("Workspace Sandbox backend is not configured");
  stage = `${config.provider} Sandbox backend`;
  await (config.provider === "kubernetes" ? createKubernetesSandboxBackend(config) : createDockerSandboxBackend(config)).health();
  stage = "model channels";
  const selections = (await settingsRepository.get())?.workspaceModels ?? {};
  for (const kind of WORKSPACE_MODEL_RUNTIMES) {
    if (selections[kind] && !await getWorkspaceRuntimeConfig(kind)) throw new Error("Workspace runtime model channel is missing");
  }
  if (process.argv.includes("--worker")) {
    await checkHeartbeat();
  }
  console.log("OK Workspace configuration, Sandbox backend and model channels");
}
main().catch(() => { console.error(`Workspace health check failed: ${stage}`); process.exitCode = 1; }).finally(closePool);
