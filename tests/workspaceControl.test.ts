import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

// Execute the real dispatcher with filesystem/process boundaries replaced, without a Sandbox or clock.
const source = readFileSync(new URL("../sandbox/control.mjs", import.meta.url), "utf8").replace(/^import .*;\n/gm, "");
async function observe(publishDuringLookup: boolean) {
  let resultLookups = 0;
  const absent = () => Object.assign(new Error("missing"), { code: "ENOENT" });
  const fs = {
    lstat: vi.fn(async (file: string) => {
      if (file.endsWith("/result") && (!publishDuringLookup || ++resultLookups === 1)) throw absent();
      return {};
    }),
    readFile: vi.fn(async (file: string) => {
      if (file.endsWith("/process")) return JSON.stringify({ pid: 42, birth: "original" });
      if (file === "/proc/42/stat") throw absent();
      if (file.endsWith("/result")) return JSON.stringify({ status: "succeeded", exitCode: 0, truncated: false });
      throw new Error(`Unexpected read: ${file}`);
    }),
  };
  let output = "";
  const process = { argv: ["node", "control.mjs", "operation"], env: {},
    stdin: (async function* () { yield Buffer.from(JSON.stringify({ id: "completed-check" })); })(),
    stdout: { write: (text: string) => { output += text; } },
    stderr: { write: (text: string) => { throw new Error(text); } }, exitCode: 0 };
  await runInNewContext(`(async () => { ${source} })()`, { fs, process, Buffer });
  return JSON.parse(output);
}

describe("Sandbox operation observation", () => {
  it("rechecks a transient proc permission transition without leaving workload processes alive", async () => {
    const denied = () => Object.assign(new Error("denied"), { code: "EACCES" });
    let reads = 0;
    const fs = { readdir: async () => ["1", "42"], readFile: vi.fn(async (file: string) => {
      if (file === "/proc/1/status") return "Uid:\t0\t0\t0\t0\n";
      if (++reads === 1) throw denied();
      return "Uid:\t1000\t1000\t1000\t1000\n";
    }) };
    const kill = vi.fn();
    const sleep = vi.fn(async () => {});
    const declarations = source.slice(0, source.indexOf('\ntry {\n  if (command === "serve")'));
    await runInNewContext(`(async () => { ${declarations}; await killWorkload(); })()`, {
      fs, process: { argv: [], kill }, delay: sleep,
    });
    expect(kill).toHaveBeenCalledExactlyOnceWith(42, "SIGKILL");
    expect(sleep).toHaveBeenCalled();
  });

  it("fails closed when proc status stays inaccessible", async () => {
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    const fs = { readdir: async () => ["42"], readFile: vi.fn(async () => { throw denied; }) };
    const kill = vi.fn();
    const declarations = source.slice(0, source.indexOf('\ntry {\n  if (command === "serve")'));
    await expect(runInNewContext(`(async () => { ${declarations}; await killWorkload(); })()`, {
      fs, process: { argv: [], kill }, delay: async () => {},
    })).rejects.toThrow("denied");
    expect(kill).not.toHaveBeenCalled();
    expect(fs.readFile).toHaveBeenCalledTimes(10);
  });

  it("accepts a denied proc entry only after observing that the process exited", async () => {
    let calls = 0;
    const fs = { readdir: async () => ["42"], readFile: vi.fn(async () => {
      throw Object.assign(new Error("proc transition"), { code: ++calls === 1 ? "EACCES" : "ENOENT" });
    }) };
    const kill = vi.fn();
    const declarations = source.slice(0, source.indexOf('\ntry {\n  if (command === "serve")'));
    await runInNewContext(`(async () => { ${declarations}; await killWorkload(); })()`, {
      fs, process: { argv: [], kill }, delay: async () => {},
    });
    expect(fs.readFile).toHaveBeenCalledTimes(2);
    expect(kill).not.toHaveBeenCalled();
  });

  it("also handles the proc transition while checking supervisor birth identity", async () => {
    let calls = 0;
    const fs = { readFile: vi.fn(async () => {
      throw Object.assign(new Error("proc transition"), { code: ++calls === 1 ? "EACCES" : "ESRCH" });
    }) };
    const declarations = source.slice(0, source.indexOf('\ntry {\n  if (command === "serve")'));
    const result = await runInNewContext(`(async () => { ${declarations}; return birth(42); })()`, {
      fs, process: { argv: [] }, delay: async () => {},
    });
    expect(result).toBeNull();
    expect(fs.readFile).toHaveBeenCalledTimes(2);
  });
  it("reads a completion published between the first result check and supervisor exit observation", async () => {
    expect(await observe(true)).toEqual({ id: "completed-check", status: "succeeded", exitCode: 0, truncated: false });
  });
  it("reports a dead supervisor with no committed result as missing", async () => {
    expect(await observe(false)).toEqual({ id: "completed-check", status: "missing" });
  });
});
