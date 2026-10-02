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
  it("reads a completion published between the first result check and supervisor exit observation", async () => {
    expect(await observe(true)).toEqual({ id: "completed-check", status: "succeeded", exitCode: 0, truncated: false });
  });
  it("reports a dead supervisor with no committed result as missing", async () => {
    expect(await observe(false)).toEqual({ id: "completed-check", status: "missing" });
  });
});
