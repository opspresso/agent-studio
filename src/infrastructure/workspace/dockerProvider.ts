import { spawn } from "node:child_process";
import type { SandboxProvider } from "@/domain/workspace/ports";
import { createControlledSandboxBackend, SandboxProviderError } from "./sandboxBackend";

export interface DockerSandboxConfig {
  image: string;
  network: string;
  memoryMb: number;
  cpus: number;
  diskMb: number;
  /** A worker can use a remote Docker context; the socket is never mounted into the sandbox. */
  context?: string;
}

interface ContainerInfo {
  Id: string;
  Config: { Labels: Record<string, string>; Image: string };
  State: { Running: boolean };
}

/** No shell on the host and no inherited secrets in a Docker command line. */
export function dockerCall(args: string[], input = "", maxBytes = 1024 * 1024, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let overflow = false;
    // Docker failures can echo arguments. Credentials and task prompts travel only on stdin.
    const errors: Buffer[] = [];
    let errorBytes = 0;
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) { overflow = true; child.kill("SIGKILL"); }
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errorBytes += chunk.length;
      if (errorBytes <= 8000) errors.push(chunk);
    });
    child.once("error", () => { clearTimeout(timer); reject(new SandboxProviderError("Unable to start Docker CLI")); });
    child.once("close", code => {
      clearTimeout(timer);
      if (overflow) reject(new SandboxProviderError("Sandbox response exceeded its byte limit"));
      else if (code !== 0) reject(new SandboxProviderError(Buffer.concat(errors).toString("utf8").trim() || "Docker command failed"));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export function createDockerSandboxBackend(config: DockerSandboxConfig) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,300}$/.test(config.image) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/.test(config.network) || ["host", "bridge", "default"].includes(config.network) ||
    (config.context && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/.test(config.context)) ||
    !Number.isInteger(config.memoryMb) || config.memoryMb < 128 || config.memoryMb > 65536 ||
    !Number.isInteger(config.diskMb) || config.diskMb < 64 || config.diskMb > 65536 ||
    !Number.isFinite(config.cpus) || config.cpus < 0.1 || config.cpus > 64) {
    throw new SandboxProviderError("Invalid Docker sandbox configuration");
  }
  const call = (args: string[], input?: string, maxBytes?: number, timeoutMs?: number) =>
    dockerCall([...(config.context ? ["--context", config.context] : []), ...args], input, maxBytes, timeoutMs);
  async function lookup(id: string): Promise<ContainerInfo | null> {
    // `container ls` distinguishes absence from a disconnected daemon without parsing error text.
    const ids = await call(["container", "ls", "-aq", "--no-trunc", "--filter", `id=${id}`]);
    if (!ids.trim()) return null;
    const info = JSON.parse(await call(["inspect", "--format", "{{json .}}", id])) as ContainerInfo;
    if (info.Config.Labels["agent-studio.workspace"] !== "true" || info.Id !== id) throw new SandboxProviderError("Sandbox ownership mismatch");
    return info;
  }
  const checkedId = (id: string) => {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new SandboxProviderError("Invalid sandbox handle");
    return id;
  };
  async function control<T>(id: string, action: string, request: unknown, maxBytes?: number): Promise<T> {
    checkedId(id);
    const info = await lookup(id);
    if (!info?.State.Running) throw new SandboxProviderError("Sandbox is not running");
    const lock = action.startsWith("git-") || action === "checkpoint" || action === "restore"
      ? ["flock", "-w", "2", "/control/git.flock"] : [];
    return JSON.parse(await call(["exec", "-i", "--user", "0", id, ...lock, "node", "/opt/workspace/control.mjs", action], JSON.stringify(request), maxBytes)) as T;
  }

  const backend = createControlledSandboxBackend("docker", {
    async ensure(workspaceId) {
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(workspaceId)) throw new SandboxProviderError("Invalid workspace id");
      const name = `agent-studio-workspace-${workspaceId}`;
      async function find(): Promise<string> {
        return (await call(["container", "ls", "-aq", "--no-trunc", "--filter", `name=^/${name}$`])).trim();
      }
      let id = await find();
      if (!id) {
        try {
          id = (await call(["create", "--name", name, "--label", "agent-studio.workspace=true",
            "--label", `agent-studio.workspace-id=${workspaceId}`, "--init", "--read-only",
            "--security-opt", "no-new-privileges", "--cap-drop", "ALL",
            ...["SETUID", "SETGID", "CHOWN", "FOWNER", "DAC_OVERRIDE", "KILL"].flatMap(cap => ["--cap-add", cap]),
            "--pids-limit", "256", "--memory", `${config.memoryMb}m`, "--memory-swap", `${config.memoryMb}m`,
            "--cpus", String(config.cpus), "--network", config.network,
            "--tmpfs", `/workspace:rw,exec,nosuid,nodev,size=${config.diskMb}m`,
            "--tmpfs", `/control:rw,nosuid,nodev,size=${config.diskMb}m`,
            "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=256m", config.image])).trim();
        } catch (error) {
          id = await find();
          if (!id) throw error;
        }
      }
      const info = await lookup(checkedId(id));
      if (!info || info.Config.Labels["agent-studio.workspace-id"] !== workspaceId || info.Config.Image !== config.image) {
        throw new SandboxProviderError("Existing sandbox configuration mismatch");
      }
      if (!info.State.Running) await call(["start", id]);
      await control(id, "ready", {});
      return { externalId: id };
    },
    async inspect(id) { const info = await lookup(checkedId(id)); return !info ? "missing" : info.State.Running ? "ready" : "stopped"; },
    async destroy(id) {
      if (await lookup(checkedId(id))) await call(["rm", "-f", id]);
    },
  }, control);
  return { ...backend, async health() {
    const info = JSON.parse(await call(["info", "--format", "{{json .}}"], undefined, undefined, 10_000)) as { MemoryLimit?: boolean; PidsLimit?: boolean; CpuCfsQuota?: boolean };
    if (!info.MemoryLimit || !info.PidsLimit || !info.CpuCfsQuota) throw new SandboxProviderError("Workspace Docker resource limits are unavailable");
    await call(["image", "inspect", config.image, "--format", "{{.Id}}"], undefined, undefined, 10_000);
    if (config.network !== "none") await call(["network", "inspect", config.network, "--format", "{{.Id}}"], undefined, undefined, 10_000);
  } };
}

export function createDockerSandboxProvider(config: DockerSandboxConfig): SandboxProvider {
  return createDockerSandboxBackend(config).provider;
}
