import { runAudioWorkerService } from "@/lib/container";
import { log } from "@/shared/logger";

const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
process.once("SIGINT", () => controller.abort());
runAudioWorkerService(controller.signal).catch(() => {
  log.error("audio-worker", "Audio worker stopped unexpectedly; check its configuration and service dependencies");
  process.exitCode = 1;
});
