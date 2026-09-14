import { runWorkspaceWorkerService } from "@/lib/container";
import { log } from "@/shared/logger";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { WORKSPACE_HEARTBEAT_FILE } from "./workspace-heartbeat";

const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
process.once("SIGINT", () => controller.abort());
runWorkspaceWorkerService(controller.signal, async () => {
  const file = await open(WORKSPACE_HEARTBEAT_FILE, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(String(Date.now())); } finally { await file.close(); }
}).catch(() => {
  log.error("workspace-worker", "Workspace worker stopped; check configuration and service dependencies");
  process.exitCode = 1;
});
