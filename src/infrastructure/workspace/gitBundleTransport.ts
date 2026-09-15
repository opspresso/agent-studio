import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_LIMITS } from "@/domain/workspace/limits";
import { isGitBranch } from "@/domain/workspace/policy";
import { serverGitFailure } from "./gitFailure";

export interface GitBundleRemote { url: string; resolve?: string }

/** Bare object transport only: repository files, hooks and build scripts never execute on the host. */
export function createGitBundleTransport(getToken: () => Promise<string>) {
  async function git(cwd: string, args: string[], remote?: GitBundleRemote, localBundle = false): Promise<string> {
    const config: [string, string][] = [["core.hooksPath", "/dev/null"], ["core.fsmonitor", "false"], ["core.sshCommand", "false"],
      ["credential.helper", ""], ["protocol.file.allow", localBundle ? "always" : "never"],
      ["protocol.ext.allow", "never"], ["http.followRedirects", "false"], ["init.templateDir", "/dev/null"],
      ["transfer.fsckObjects", "true"]];
    if (remote) {
      const token = await getToken();
      if (!token || /[\r\n]/.test(token)) throw new Error("Invalid server Git credential");
      config.push([`http.${new URL(remote.url).origin}/.extraHeader`, `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`]);
      if (remote.resolve) config.push(["http.curloptResolve", remote.resolve]);
    }
    const env: NodeJS.ProcessEnv = { NODE_ENV: "production", PATH: "/usr/bin:/bin", HOME: cwd,
      LANG: "C.UTF-8", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: String(config.length) };
    config.forEach(([key, value], index) => { env[`GIT_CONFIG_KEY_${index}`] = key; env[`GIT_CONFIG_VALUE_${index}`] = value; });
    return new Promise((resolve, reject) => {
      const child = spawn("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      const chunks: Buffer[] = [];
      const diagnostics: Buffer[] = [];
      let diagnosticBytes = 0;
      let bytes = 0;
      const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) child.kill("SIGKILL"); else chunks.push(chunk);
      });
      // Keep only a bounded prefix for classification; never emit raw remote diagnostics.
      child.stderr.on("data", (chunk: Buffer) => {
        const remaining = WORKSPACE_LIMITS.errorBytes - diagnosticBytes;
        if (remaining > 0) { const kept = chunk.subarray(0, remaining); diagnostics.push(kept); diagnosticBytes += kept.length; }
      });
      child.once("error", () => { clearTimeout(timer); reject(new Error("Unable to start server Git")); });
      child.once("close", code => {
        clearTimeout(timer);
        const operation = args[0]?.startsWith("--git-dir=") ? args[1]! : args[0]!;
        if (code !== 0 || bytes > 1024 * 1024) reject(new Error(serverGitFailure(operation, code, remote ? Buffer.concat(diagnostics).toString("utf8") : "")));
        else resolve(Buffer.concat(chunks).toString("utf8").trim());
      });
    });
  }
  async function temporary<T>(run: (directory: string) => Promise<T>): Promise<T> {
    const directory = await mkdtemp(join(tmpdir(), "agent-studio-git-"));
    try { return await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
  }
  return {
    async download(remote: GitBundleRemote, baseBranch: string): Promise<string> {
      if (!isGitBranch(baseBranch)) throw new Error("Invalid Git base branch");
      return temporary(async directory => {
        await git(directory, ["clone", "--bare", "--no-tags", "--single-branch", "--branch", baseBranch, "--", remote.url, "objects"], remote);
        await git(directory, ["--git-dir=objects", "bundle", "create", "source.bundle", `refs/heads/${baseBranch}`]);
        const file = join(directory, "source.bundle");
        if ((await stat(file)).size > WORKSPACE_LIMITS.checkpointBytes) throw new Error("Repository bundle exceeds Workspace storage limit");
        return (await readFile(file)).toString("base64");
      });
    },
    async upload(remote: GitBundleRemote, branch: string, headSha: string, bundle: string): Promise<void> {
      if (!isGitBranch(branch) || !branch.startsWith("agent/") || !/^[a-f0-9]{40,64}$/.test(headSha)) throw new Error("Invalid Git publication target");
      if (Buffer.byteLength(bundle, "base64") > WORKSPACE_LIMITS.checkpointBytes) throw new Error("Repository bundle exceeds Workspace storage limit");
      await temporary(async directory => {
        await writeFile(join(directory, "source.bundle"), Buffer.from(bundle, "base64"), { mode: 0o600, flag: "wx" });
        await git(directory, ["clone", "--bare", "--single-branch", "--branch", branch, "--", join(directory, "source.bundle"), "objects"], undefined, true);
        const current = await git(directory, ["--git-dir=objects", "rev-parse", `refs/heads/${branch}`]);
        if (current !== headSha) throw new Error("Git publication head differs from the approved commit");
        await git(directory, ["--git-dir=objects", "push", "--", remote.url, `${headSha}:refs/heads/${branch}`], remote);
      });
    },
  };
}
