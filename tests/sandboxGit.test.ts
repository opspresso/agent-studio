import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../sandbox/git.mjs", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "").replace(/^export /gm, "");
const request = { url: "https://git.example.test/org/repo.git", branch: "agent/workspace", baseBranch: "main" };

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime("2026-01-01T00:00:00Z"); });
afterEach(() => vi.useRealTimers());

function fixture() {
  const spawn = vi.fn(() => { throw new Error("Unexpected Git subprocess"); });
  const fs = { lstat: vi.fn(async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); }),
    readdir: vi.fn(async () => []), writeFile: vi.fn(), rm: vi.fn() };
  const handleGit = runInNewContext(`(() => { ${source}; return handleGit; })()`, { fs, spawn, Buffer, URL, Date, setTimeout, clearTimeout });
  return { handleGit, spawn };
}

describe("Sandbox Git credential boundary", () => {
  it("requires a bundle instead of cloning a remote from the Sandbox", async () => {
    const { handleGit, spawn } = fixture();
    await expect(handleGit("git-prepare", request)).rejects.toThrow("Repository bundle is required");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects credentials even when a bundle was supplied", async () => {
    const { handleGit, spawn } = fixture();
    await expect(handleGit("git-prepare", { ...request, bundle: "AA==", token: "synthetic-token", expiresAt: "2026-01-01T00:01:00Z" }))
      .rejects.toThrow("Sandbox Git accepts credential-free requests only");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not expose a remote push command", async () => {
    const { handleGit, spawn } = fixture();
    await expect(handleGit("git-push", request)).rejects.toThrow("Unknown Git operation");
    expect(spawn).not.toHaveBeenCalled();
  });
});
