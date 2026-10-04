import { readFile } from "node:fs/promises";

export const WORKSPACE_HEARTBEAT_FILE = "/tmp/workspace-worker.heartbeat";
export const WORKSPACE_HEARTBEAT_MAX_AGE_MS = 30_000;

export async function assertWorkspaceHeartbeat(clock: () => number = Date.now): Promise<void> {
  const timestamp = Number(await readFile(WORKSPACE_HEARTBEAT_FILE, "utf8"));
  const now = clock();
  if (!Number.isFinite(timestamp) || timestamp > now || now - timestamp > WORKSPACE_HEARTBEAT_MAX_AGE_MS) {
    throw new Error("Workspace worker heartbeat is stale");
  }
}
