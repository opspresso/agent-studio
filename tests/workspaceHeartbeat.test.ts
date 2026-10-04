import { beforeEach, describe, expect, it, vi } from "vitest";

const readFile = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", () => ({ readFile }));

import { assertWorkspaceHeartbeat, WORKSPACE_HEARTBEAT_FILE, WORKSPACE_HEARTBEAT_MAX_AGE_MS } from "../scripts/workspace-heartbeat";

const now = 1_700_000_000_000;

beforeEach(() => { readFile.mockReset(); });

describe("Workspace process heartbeat", () => {
  it.each([0, WORKSPACE_HEARTBEAT_MAX_AGE_MS])("accepts a heartbeat aged %d ms", async age => {
    readFile.mockResolvedValue(String(now - age));
    await expect(assertWorkspaceHeartbeat(() => now)).resolves.toBeUndefined();
    expect(readFile).toHaveBeenCalledWith(WORKSPACE_HEARTBEAT_FILE, "utf8");
  });

  it.each([String(now - WORKSPACE_HEARTBEAT_MAX_AGE_MS - 1), String(now + 1), "NaN", "Infinity", ""])("rejects an unusable heartbeat: %s", async timestamp => {
    readFile.mockResolvedValue(timestamp);
    await expect(assertWorkspaceHeartbeat(() => now)).rejects.toThrow("Workspace worker heartbeat is stale");
  });

  it("preserves missing-file failures so a worker that never published a heartbeat cannot be healthy", async () => {
    const missing = Object.assign(new Error("missing heartbeat"), { code: "ENOENT" });
    readFile.mockRejectedValue(missing);
    await expect(assertWorkspaceHeartbeat(() => now)).rejects.toBe(missing);
  });

  it("samples time after reading so a concurrent heartbeat update is not mistaken for a future timestamp", async () => {
    let complete!: (value: string) => void;
    readFile.mockReturnValue(new Promise<string>(resolve => { complete = resolve; }));
    const clock = vi.fn(() => now);
    const check = assertWorkspaceHeartbeat(clock);
    expect(clock).not.toHaveBeenCalled();
    complete(String(now));
    await expect(check).resolves.toBeUndefined();
    expect(clock).toHaveBeenCalledTimes(1);
  });
});
