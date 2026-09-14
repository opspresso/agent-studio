// Trusted control program. Requests arrive only through the provider's Docker exec,
// never over a port accessible to an agent. Workspace commands run as uid/gid 1000.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { StringDecoder } from "node:string_decoder";

const root = "/control";
const work = "/workspace/repo";
const home = "/workspace/home";
const maxLogBytes = 16 * 1024 * 1024;
const maxSnapshotBytes = 64 * 1024 * 1024;
const maxFiles = 20_000;
const command = process.argv[2];
const writeJson = (file, data) => fs.writeFile(file, JSON.stringify(data), { mode: 0o600 });
const readJson = async file => JSON.parse(await fs.readFile(file, "utf8"));
function identifier(id) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new Error("Invalid operation id");
  return id;
}
async function exists(file) {
  try { await fs.lstat(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
async function init() {
  await fs.mkdir(root, { recursive: true, mode: 0o755 });
  await fs.mkdir(`${root}/operations`, { recursive: true, mode: 0o700 });
  await fs.mkdir(work, { recursive: true, mode: 0o1777 });
  await fs.chmod(work, 0o1777);
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  await fs.chown(home, 1000, 1000);
}
async function input() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > maxSnapshotBytes * 2) throw new Error("Control request is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function safeCommand(spec) {
  if (!Array.isArray(spec.argv) || !spec.argv.length || spec.argv.some(arg => typeof arg !== "string" || arg.includes("\0"))) {
    throw new Error("Invalid command arguments");
  }
  const cwd = path.resolve(spec.cwd || work);
  if (cwd !== work && !cwd.startsWith(`${work}/`)) throw new Error("Command must run in workspace");
  if (!Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs < 1 || spec.timeoutMs > 86_400_000) throw new Error("Invalid command deadline");
  const env = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: home, LANG: "C.UTF-8", CI: "true",
    CODEX_HOME: `${home}/.codex`, CLAUDE_CONFIG_DIR: `${home}/.claude`, XDG_DATA_HOME: `${home}/.local/share`,
    XDG_CONFIG_HOME: `${home}/.config`, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: work,
    DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", OPENCODE_DISABLE_AUTOUPDATE: "true" };
  const allowed = new Set(["OPENAI_API_KEY", "OPENAI_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "OPENCODE_CONFIG_CONTENT"]);
  for (const [key, value] of Object.entries(spec.environment || {})) {
    if (!allowed.has(key) || typeof value !== "string" || value.includes("\0")) throw new Error("Unsupported runtime environment");
    env[key] = value;
  }
  return { cwd, env };
}
async function killWorkload() {
  // No command's daemon may continue modifying files after that command has ended.
  for (const id of await fs.readdir("/proc")) {
    if (!/^\d+$/.test(id)) continue;
    try {
      const status = await fs.readFile(`/proc/${id}/status`, "utf8");
      if (/^Uid:\s+1000\s/m.test(status)) process.kill(Number(id), "SIGKILL");
    } catch (error) { if (!["ENOENT", "ESRCH"].includes(error.code)) throw error; }
  }
}
async function birth(pid) {
  try { const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8"); return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]; }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function operation(id) {
  const dir = `${root}/operations/${identifier(id)}`;
  if (await exists(`${dir}/result`)) return { id, ...await readJson(`${dir}/result`) };
  if (!(await exists(dir))) return { id, status: "not-started" };
  if (!(await exists(`${dir}/process`))) return { id, status: Date.now() - (await fs.stat(dir)).mtimeMs < 5000 ? "starting" : "missing" };
  const record = await readJson(`${dir}/process`);
  return { id, status: await birth(record.pid) === record.birth ? "running" : "missing" };
}
async function run(id) {
  const dir = `${root}/operations/${identifier(id)}`;
  const active = `${root}/active`;
  if (await exists(`${active}/owner`)) {
    const owner = await readJson(`${active}/owner`);
    if (await birth(owner.pid) !== owner.birth) { await killWorkload(); await fs.rm(active, { recursive: true }); }
  }
  await fs.mkdir(active, { mode: 0o700 });
  await writeJson(`${active}/owner`, { id, pid: process.pid, birth: await birth(process.pid) });
  try {
    const spec = await readJson(`${dir}/request`);
    await fs.unlink(`${dir}/request`);
    await writeJson(`${dir}/process`, { pid: process.pid, birth: await birth(process.pid) });
    const { cwd, env } = safeCommand(spec);
    const out = await fs.open(`${dir}/output`, "a", 0o600);
    let bytes = 0;
    let truncated = false;
    let writes = Promise.resolve();
    const append = (stream, text) => {
      for (let at = 0; at < text.length;) {
        let end = Math.min(at + 2000, text.length);
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
        const fragment = text.slice(at, end);
        at = end;
        const frame = JSON.stringify({ stream, text: fragment }) + "\n";
        if (bytes + Buffer.byteLength(frame) > maxLogBytes) { truncated = true; continue; }
        bytes += Buffer.byteLength(frame);
        writes = writes.then(() => out.write(frame));
      }
    };
    const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd, env, uid: 1000, gid: 1000, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const timeout = setTimeout(() => { void killWorkload(); }, spec.timeoutMs);
    for (const stream of ["stdout", "stderr"]) {
      const decoder = new StringDecoder("utf8");
      child[stream].on("data", chunk => append(stream, decoder.write(chunk)));
      child[stream].on("end", () => append(stream, decoder.end()));
    }
    child.stdin.on("error", () => {});
    child.stdin.end(spec.stdin || "");
    const exitCode = await new Promise(resolve => {
      child.once("error", error => { append("stderr", `Unable to start command: ${error.code || "error"}\n`); resolve(127); });
      child.once("close", code => resolve(code ?? 137));
    });
    clearTimeout(timeout);
    await killWorkload();
    await writes;
    await out.close();
    await writeJson(`${dir}/result.tmp`, { status: exitCode === 0 ? "succeeded" : "failed", exitCode, truncated });
    await fs.rm(active, { recursive: true });
    await fs.rename(`${dir}/result.tmp`, `${dir}/result`);
  } finally {
    if (await exists(`${active}/owner`)) {
      const owner = await readJson(`${active}/owner`);
      if (owner.id === id && owner.pid === process.pid) await fs.rm(active, { recursive: true });
    }
  }
}
async function snapshot() {
  if (await exists(`${root}/active`)) throw new Error("Cannot checkpoint a running workspace");
  const entries = [];
  let total = 0;
  const excluded = new Set(["repo/.git", "home/.codex/auth.json", "home/.claude/.credentials.json", "home/.local/share/opencode/auth.json"]);
  async function visit(base, relative = "") {
    for (const name of await fs.readdir(base)) {
      const rel = relative ? `${relative}/${name}` : name;
      if (excluded.has(rel)) continue;
      if (entries.length >= maxFiles) throw new Error("Workspace checkpoint file count exceeded");
      const file = path.join(base, name);
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) {
        const target = await fs.readlink(file);
        const resolved = path.resolve(path.dirname(file), target);
        if (!resolved.startsWith("/workspace/")) throw new Error("Workspace checkpoint contains an external symlink");
        entries.push({ path: rel, kind: "link", target });
      } else if (stat.isDirectory()) {
        entries.push({ path: rel, kind: "directory", mode: stat.mode & 0o777 });
        await visit(file, rel);
      } else if (stat.isFile()) {
        total += stat.size;
        if (total > maxSnapshotBytes) throw new Error("Workspace checkpoint exceeds storage limit");
        entries.push({ path: rel, kind: "file", mode: stat.mode & 0o777, content: (await fs.readFile(file)).toString("base64") });
      } else throw new Error("Workspace checkpoint contains an unsupported special file");
    }
  }
  await visit("/workspace");
  if (await exists(`${root}/git`)) {
    entries.push({ path: "git", kind: "directory", mode: 0o755 });
    await visit(`${root}/git`, "git");
  }
  const bytes = gzipSync(JSON.stringify(entries));
  if (bytes.length > maxSnapshotBytes) throw new Error("Workspace checkpoint exceeds storage limit");
  return { bytes: bytes.toString("base64") };
}
async function restore(encoded) {
  const entries = JSON.parse(gunzipSync(Buffer.from(encoded, "base64"), { maxOutputLength: maxSnapshotBytes * 2 }).toString("utf8"));
  if (!Array.isArray(entries) || entries.length > maxFiles) throw new Error("Invalid checkpoint");
  const seen = new Set();
  const links = new Set();
  let total = 0;
  // Validate every address before writing anything. Links are restored last and can never be parents.
  for (const entry of entries) {
    if (typeof entry.path !== "string" || !/^(repo|home|git)(\/|$)/.test(entry.path) ||
      entry.path.split("/").some(part => !part || part === "." || part === "..") || entry.path.includes("\0") ||
      entry.path === "repo/.git" || seen.has(entry.path)) throw new Error("Invalid checkpoint path");
    seen.add(entry.path);
    if (!["file", "directory", "link"].includes(entry.kind)) throw new Error("Invalid checkpoint entry");
    if (entry.kind === "file") {
      if (typeof entry.content !== "string") throw new Error("Invalid checkpoint content");
      total += Buffer.byteLength(entry.content, "base64");
      if (total > maxSnapshotBytes) throw new Error("Workspace checkpoint exceeds storage limit");
    }
    if (entry.kind === "link") {
      if (typeof entry.target !== "string" || entry.path.startsWith("git/")) throw new Error("Invalid checkpoint link");
      const resolved = path.resolve("/workspace", path.dirname(entry.path), entry.target);
      if (!resolved.startsWith("/workspace/")) throw new Error("Invalid checkpoint link");
      links.add(entry.path);
    }
  }
  for (const entry of entries) {
    let parent = path.dirname(entry.path);
    while (parent !== ".") {
      if (links.has(parent)) throw new Error("Checkpoint link cannot be a parent");
      parent = path.dirname(parent);
    }
  }
  if ((await fs.readdir(work)).length || (await fs.readdir(home)).length || await exists(`${root}/git`)) throw new Error("Restore requires an empty sandbox");
  for (const entry of entries.filter(value => value.kind !== "link").concat(entries.filter(value => value.kind === "link"))) {
    const file = path.join(entry.path === "git" || entry.path.startsWith("git/") ? root : "/workspace", entry.path);
    if (entry.kind === "directory") await fs.mkdir(file, { recursive: true });
    else if (entry.kind === "file") await fs.writeFile(file, Buffer.from(entry.content, "base64"), { flag: "wx" });
    else await fs.symlink(entry.target, file);
    if (entry.kind !== "link") await fs.chmod(file, entry.kind === "directory" ? 0o755 : ((entry.mode || 0o644) & 0o777));
    if (!entry.path.startsWith("git") && entry.path !== "repo") await fs.lchown(file, 1000, 1000);
  }
  await fs.chmod(work, 0o1777);
  if (await exists(`${root}/git`)) await fs.writeFile(`${work}/.git`, `gitdir: ${root}/git\n`, { mode: 0o644 });
  return { restored: true };
}

try {
  if (command === "serve") { await init(); setInterval(() => {}, 60_000); }
  else if (command === "run") await run(process.argv[3]);
  else {
    const request = await input();
    let result;
    if (command === "ready") { await init(); result = { ready: true }; }
    else if (command === "execute") {
      const id = identifier(request.id);
      safeCommand(request.command);
      const dir = `${root}/operations/${id}`;
      await fs.mkdir(dir, { mode: 0o700 });
      await writeJson(`${dir}/request`, request.command);
      await run(id);
      const state = await readJson(`${dir}/result`);
      const frames = (await fs.readFile(`${dir}/output`, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
      result = { exitCode: state.exitCode, stdout: frames.filter(frame => frame.stream === "stdout").map(frame => frame.text).join(""),
        stderr: frames.filter(frame => frame.stream === "stderr").map(frame => frame.text).join("") };
    } else if (command === "start") {
      const id = identifier(request.id);
      safeCommand(request.command);
      const dir = `${root}/operations/${id}`;
      const fingerprint = createHash("sha256").update(JSON.stringify(request.command)).digest("hex");
      try {
        await fs.mkdir(dir, { mode: 0o700 });
        await writeJson(`${dir}/fingerprint`, fingerprint);
        await writeJson(`${dir}/request`, request.command);
        const child = spawn(process.execPath, ["/opt/workspace/control.mjs", "run", id], { detached: true, stdio: "ignore" });
        child.unref();
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (await readJson(`${dir}/fingerprint`) !== fingerprint) throw new Error("Operation input changed");
      }
      result = { id };
    } else if (command === "operation") result = await operation(request.id);
    else if (command === "output") {
      const dir = `${root}/operations/${identifier(request.id)}`;
      if (!Number.isSafeInteger(request.offset) || request.offset < 0) throw new Error("Invalid output cursor");
      if (!(await exists(`${dir}/output`))) result = { text: "", nextOffset: request.offset };
      else {
        const file = await fs.open(`${dir}/output`);
        try {
          const buffer = Buffer.alloc(32_000);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, request.offset);
          const end = buffer.subarray(0, bytesRead).lastIndexOf(10) + 1;
          result = { text: buffer.subarray(0, end).toString("utf8"), nextOffset: request.offset + end };
        } finally { await file.close(); }
      }
    } else if (command === "cancel") {
      identifier(request.id);
      const active = `${root}/active/owner`;
      const owner = await exists(active) ? await readJson(active) : null;
      if (owner?.id === request.id) {
        await killWorkload();
        if (await birth(owner.pid) !== owner.birth) await fs.rm(`${root}/active`, { recursive: true });
      }
      result = { cancelled: owner?.id === request.id };
    }
    else if (command === "checkpoint") result = await snapshot();
    else if (command === "restore") result = await restore(request.bytes);
    else throw new Error("Unknown control command");
    process.stdout.write(JSON.stringify(result));
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
