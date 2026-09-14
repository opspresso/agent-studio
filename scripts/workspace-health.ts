import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { getWorkspaceConfig, getWorkspaceGitHubConfig, getGitHubToken, getLlmProviderConfigs } from "@/lib/runtime-settings";
import { withWorkspaceModelChannel } from "@/infrastructure/workspace/runtimeAdapters";
import { createDockerSandboxBackend } from "@/infrastructure/workspace/dockerProvider";
import { closePool } from "@/infrastructure/db/client";
import { WORKSPACE_HEARTBEAT_FILE, WORKSPACE_HEARTBEAT_MAX_AGE_MS } from "./workspace-heartbeat";

let stage = "configuration";
async function main() {
  const config = getWorkspaceConfig();
  if (!config?.projects.length) throw new Error("Workspace projects are not configured");
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
  const channels = await getLlmProviderConfigs();
  for (const kind of new Set(config.projects.flatMap(project => project.runtimes))) {
    const runtime = config.runtimes[kind];
    if (runtime?.provider) {
      const channel = channels.find(item => item.name === runtime.provider);
      if (!channel) throw new Error("Workspace model channel is missing");
      withWorkspaceModelChannel(kind, runtime, channel);
    } else if (kind !== "command" && !runtime?.environment) throw new Error("Workspace model authentication is missing");
  }
  stage = "GitHub configuration";
  if (config.projects.some(project => project.repository || project.repositories?.length)) {
    const github = getWorkspaceGitHubConfig();
    if (!github || (github.auth === "token" && !await getGitHubToken())) throw new Error("Workspace GitHub integration is missing");
  }
  if (process.argv.includes("--worker")) {
    stage = "worker heartbeat";
    const timestamp = Number(await readFile(WORKSPACE_HEARTBEAT_FILE, "utf8"));
    if (!Number.isFinite(timestamp) || Date.now() - timestamp > WORKSPACE_HEARTBEAT_MAX_AGE_MS || timestamp > Date.now()) throw new Error("Workspace worker heartbeat is stale");
  }
  console.log("OK Workspace configuration, Docker, image, network and model channels");
}
main().catch(() => { console.error(`Workspace health check failed: ${stage}`); process.exitCode = 1; }).finally(closePool);
