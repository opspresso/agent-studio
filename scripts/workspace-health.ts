import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { getWorkspaceConfig, getWorkspaceGitHubConfig, getGitHubToken, getWorkspaceRuntimeConfig } from "@/lib/runtime-settings";
import { WORKSPACE_MODEL_RUNTIMES } from "@/domain/workspace/runtimeModels";
import { settingsRepository } from "@/infrastructure/db/repositories/settingsRepository";
import { createDockerSandboxBackend } from "@/infrastructure/workspace/dockerProvider";
import { closePool } from "@/infrastructure/db/client";
import { WORKSPACE_HEARTBEAT_FILE, WORKSPACE_HEARTBEAT_MAX_AGE_MS } from "./workspace-heartbeat";

let stage = "configuration";
async function main() {
  const config = getWorkspaceConfig();
  if (!config) throw new Error("Workspace Sandbox backend is not configured");
  createDockerSandboxBackend(config);
  const docker = (args: string[]) => execFileSync("docker", [...(config.context ? ["--context", config.context] : []), ...args],
    { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  stage = "Docker engine and resource limits";
  const info = JSON.parse(docker(["info", "--format", "{{json .}}"]));
  if (!info.MemoryLimit || !info.PidsLimit || !info.CpuCfsQuota) throw new Error("Workspace Docker resource limits are unavailable");
  stage = "Sandbox image";
  docker(["image", "inspect", config.image, "--format", "{{.Id}}"]);
  stage = "Sandbox network";
  if (config.network !== "none") docker(["network", "inspect", config.network, "--format", "{{.Id}}"]);
  stage = "model channels";
  const selections = (await settingsRepository.get())?.workspaceModels ?? {};
  for (const kind of WORKSPACE_MODEL_RUNTIMES) {
    if (selections[kind] && !await getWorkspaceRuntimeConfig(kind)) throw new Error("Workspace runtime model channel is missing");
  }
  stage = "GitHub configuration";
  const github = getWorkspaceGitHubConfig();
  if (github?.auth === "token" && !await getGitHubToken()) throw new Error("Workspace GitHub integration is missing");
  if (process.argv.includes("--worker")) {
    stage = "worker heartbeat";
    const timestamp = Number(await readFile(WORKSPACE_HEARTBEAT_FILE, "utf8"));
    if (!Number.isFinite(timestamp) || Date.now() - timestamp > WORKSPACE_HEARTBEAT_MAX_AGE_MS || timestamp > Date.now()) throw new Error("Workspace worker heartbeat is stale");
  }
  console.log("OK Workspace configuration, Docker, image, network and model channels");
}
main().catch(() => { console.error(`Workspace health check failed: ${stage}`); process.exitCode = 1; }).finally(closePool);
