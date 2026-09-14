import { runWorkspaceWorkerService } from "@/lib/container";
import { log } from "@/shared/logger";

const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
process.once("SIGINT", () => controller.abort());
runWorkspaceWorkerService(controller.signal).catch(() => {
  log.error("workspace-worker", "Workspace worker stopped; check configuration and service dependencies");
  process.exitCode = 1;
});
