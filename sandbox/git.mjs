import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

// The Docker backend holds /control/git.flock for this entire control process.

const root = "/control";
const gitDir = `${root}/git`;
const work = "/workspace/repo";
const safeConfig = [["core.hooksPath", "/dev/null"], ["core.fsmonitor", "false"], ["core.sshCommand", "false"],
  ["credential.helper", ""], ["protocol.file.allow", "never"], ["protocol.ext.allow", "never"],
  ["http.followRedirects", "false"], ["init.templateDir", "/dev/null"]];

async function exists(file) {
  try { await fs.lstat(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
function safeBranch(value) {
  if (typeof value !== "string" || !value || value.length > 200 || value.startsWith("-") || /[\x00-\x20~^:?*\[\\]/.test(value) || value.includes("..") || value.includes("@{")) throw new Error("Invalid Git branch");
  return value;
}
function git(args, options = {}) {
  const config = [...safeConfig, ...(options.config || [])];
  const env = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/control", LANG: "C.UTF-8", GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: String(config.length), ...options.env };
  config.forEach(([key, value], index) => { env[`GIT_CONFIG_KEY_${index}`] = key; env[`GIT_CONFIG_VALUE_${index}`] = value; });
  return new Promise((resolve, reject) => {
    const child = spawn("git", options.unbound ? args : [`--git-dir=${gitDir}`, `--work-tree=${work}`, ...args],
      { cwd: options.unbound ? "/control" : work, env, stdio: ["pipe", "pipe", "pipe"] });
    const buffers = [];
    let bytes = 0;
    let truncated = false;
    const max = options.maxBytes ?? 1024 * 1024;
    const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
    child.stdout.on("data", chunk => {
      const keep = Math.max(0, Math.min(chunk.length, max - bytes));
      if (keep) buffers.push(chunk.subarray(0, keep));
      bytes += keep;
      if (keep < chunk.length) truncated = true;
    });
    // Git errors can contain remote response data. Never echo credentials or raw repository config.
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.stdin.end(options.stdin ?? "");
    child.once("error", () => { clearTimeout(timer); reject(new Error("Unable to start Git")); });
    child.once("close", code => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`Git ${args[0]} failed (exit ${code ?? "signal"})`)); return; }
      const buffer = Buffer.concat(buffers);
      let end = buffer.length;
      if (truncated) {
        // Drop an incomplete final UTF-8 character from a bounded diff preview.
        while (end > 0 && (buffer[end - 1] & 0xc0) === 0x80) end--;
        if (end > 0 && buffer[end - 1] >= 0xc0) end--;
      }
      resolve({ text: buffer.subarray(0, end).toString("utf8"), truncated });
    });
  });
}
async function scalar(args, options) {
  const result = await git(args, options);
  if (result.truncated) throw new Error("Git metadata exceeds its bound");
  return result.text.trim();
}
function networkConfig(request) {
  const url = new URL(request.url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid Git remote URL");
  const config = [];
  if (request.resolve) config.push(["http.curloptResolve", request.resolve]);
  if (request.token) {
    if (typeof request.token !== "string" || request.token.includes("\n") || !Number.isFinite(Date.parse(request.expiresAt)) || Date.parse(request.expiresAt) <= Date.now() || Date.parse(request.expiresAt) > Date.now() + 3_700_000) {
      throw new Error("Git credentials must be short-lived");
    }
    config.push([`http.${url.origin}/.extraHeader`, `Authorization: Basic ${Buffer.from(`x-access-token:${request.token}`).toString("base64")}`]);
  }
  return config;
}
async function ownWorktree(base = work) {
  for (const name of await fs.readdir(base)) {
    if (base === work && name === ".git") continue;
    const file = path.join(base, name);
    const stat = await fs.lstat(file);
    if (stat.isDirectory()) await ownWorktree(file);
    await fs.lchown(file, 1000, 1000);
  }
  await fs.chmod(work, 0o1777);
}
async function review() {
  const index = `${root}/index-${randomUUID()}`;
  const env = { GIT_INDEX_FILE: index };
  try {
    const headSha = await scalar(["rev-parse", "HEAD"]);
    await git(["read-tree", headSha], { env });
    await git(["add", "-A", "--", "."], { env });
    const treeSha = await scalar(["write-tree"], { env });
    const diff = await git(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--binary", headSha, "--"], { env, maxBytes: 256_000 });
    return { headSha, treeSha, headTreeSha: await scalar(["rev-parse", "HEAD^{tree}"]), diff: diff.text, truncated: diff.truncated,
      fingerprint: createHash("sha256").update(`${headSha}\0${treeSha}`).digest("hex") };
  } finally { await fs.rm(index, { force: true }); await fs.rm(`${index}.lock`, { force: true }); }
}

export async function checkpointGitFiles() {
  if (!await exists(gitDir)) return null;
  await git(["gc", "--prune=now"]);
  const result = await git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { maxBytes: 4 * 1024 * 1024 });
  if (result.truncated) throw new Error("Git file inventory exceeds checkpoint limit");
  const allowed = new Set();
  for (const file of result.text.split("\0").filter(Boolean)) {
    allowed.add(`repo/${file}`);
    let parent = path.posix.dirname(file);
    while (parent !== ".") { allowed.add(`repo/${parent}`); parent = path.posix.dirname(parent); }
  }
  return allowed;
}

export async function handleGit(action, request) {
  if (action === "git-prepare") {
    const branch = safeBranch(request.branch);
    if (!branch.startsWith("agent/")) throw new Error("Workspace requires an agent branch");
    const config = networkConfig(request);
    if (!await exists(gitDir)) {
      if (request.existingOnly) throw new Error("Saved workspace Git metadata is missing");
      if ((await fs.readdir(work)).length) throw new Error("Cannot attach repository: the workdir is not empty; existing files were kept");
      const bundleFile = `${root}/source.bundle`;
      try {
        if (request.bundle !== undefined) {
          if (typeof request.bundle !== "string" || Buffer.byteLength(request.bundle, "base64") > 64 * 1024 * 1024) throw new Error("Repository bundle exceeds Workspace storage limit");
          await fs.writeFile(bundleFile, Buffer.from(request.bundle, "base64"), { mode: 0o600, flag: "wx" });
        }
        await git(["clone", "--no-checkout", "--no-tags", "--single-branch", "--branch", safeBranch(request.baseBranch),
          "--separate-git-dir", gitDir, "--", request.bundle !== undefined ? bundleFile : request.url, work],
        { config: request.bundle !== undefined ? [...config, ["protocol.file.allow", "always"]] : config, unbound: true });
        await git(["remote", "set-url", "origin", request.url]);
      } finally { await fs.rm(bundleFile, { force: true }); }
      const baseSha = await scalar(["rev-parse", "HEAD"]);
      await git(["checkout", "-B", branch, baseSha]);
      await git(["config", "agentStudio.baseSha", baseSha]);
      await git(["config", "core.hooksPath", "/dev/null"]);
      await ownWorktree();
    }
    if (await scalar(["branch", "--show-current"]) !== branch) throw new Error("Workspace Git branch changed");
    if (await scalar(["config", "--get", "remote.origin.url"]) !== request.url) throw new Error("Workspace Git remote changed");
    return { baseSha: await scalar(["config", "--get", "agentStudio.baseSha"]), headSha: await scalar(["rev-parse", "HEAD"]) };
  }
  if (action === "git-review") return await review();
  if (action === "git-commit") {
    if (await exists(`${root}/active`)) throw new Error("Cannot commit while a workspace task is running");
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(request.operationId) || typeof request.message !== "string" || !request.message.trim() || request.message.length > 8000 ||
      typeof request.ownerEmail !== "string" || /[\r\n<>]/.test(request.ownerEmail) || !Number.isFinite(Date.parse(request.createdAt))) throw new Error("Invalid commit request");
    const receiptDir = `${gitDir}/agent-studio-actions`;
    const receiptFile = `${receiptDir}/${request.operationId}`;
    const identity = createHash("sha256").update(JSON.stringify([request.fingerprint, request.message, request.ownerEmail, request.createdAt])).digest("hex");
    await fs.mkdir(receiptDir, { recursive: true });
    if (await exists(receiptFile)) {
      const receipt = JSON.parse(await fs.readFile(receiptFile, "utf8"));
      if (receipt.identity !== identity) throw new Error("Commit operation input changed");
      const current = await scalar(["rev-parse", "HEAD"]);
      if (current === receipt.parent) await git(["update-ref", receipt.ref, receipt.sha, receipt.parent]);
      else await git(["merge-base", "--is-ancestor", receipt.sha, "HEAD"]);
      return { sha: receipt.sha };
    }
    const current = await review();
    if (current.fingerprint !== request.fingerprint) throw new Error("Workspace changed since approval");
    if (current.treeSha === await scalar(["rev-parse", "HEAD^{tree}"])) throw new Error("There are no changes to commit");
    const ref = await scalar(["symbolic-ref", "HEAD"]);
    if (!ref.startsWith("refs/heads/agent/")) throw new Error("Cannot commit to a protected branch");
    const env = { GIT_AUTHOR_NAME: "Agent Studio", GIT_AUTHOR_EMAIL: request.ownerEmail, GIT_AUTHOR_DATE: request.createdAt,
      GIT_COMMITTER_NAME: "Agent Studio", GIT_COMMITTER_EMAIL: request.ownerEmail, GIT_COMMITTER_DATE: request.createdAt };
    const sha = await scalar(["commit-tree", current.treeSha, "-p", current.headSha], { stdin: request.message, env });
    await fs.writeFile(receiptFile, JSON.stringify({ identity, sha, parent: current.headSha, ref }), { flag: "wx", mode: 0o600 });
    await git(["update-ref", ref, sha, current.headSha]);
    await git(["read-tree", sha]);
    return { sha };
  }
  if (action === "git-push" || action === "git-bundle") {
    if (await exists(`${root}/active`)) throw new Error("Cannot publish while a workspace task is running");
    const branch = safeBranch(request.branch);
    if (!branch.startsWith("agent/") || await scalar(["branch", "--show-current"]) !== branch || await scalar(["rev-parse", "HEAD"]) !== request.headSha) throw new Error("Workspace Git head changed");
    if (await scalar(["config", "--get", "remote.origin.url"]) !== request.url) throw new Error("Workspace Git remote changed");
    if (action === "git-bundle") {
      const file = `${root}/publish.bundle`;
      try {
        await git(["bundle", "create", file, `refs/heads/${branch}`]);
        if ((await fs.stat(file)).size > 64 * 1024 * 1024) throw new Error("Repository bundle exceeds Workspace storage limit");
        return { bundle: (await fs.readFile(file)).toString("base64") };
      } finally { await fs.rm(file, { force: true }); }
    }
    await git(["push", "--", request.url, `HEAD:refs/heads/${branch}`], { config: networkConfig(request) });
    return { pushed: true };
  }
  throw new Error("Unknown Git operation");
}
