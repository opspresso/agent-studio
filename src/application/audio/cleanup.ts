import { removeExpiredSourceFile, type SourceFileDeps } from "@/application/artifact/sourceFiles";
import type { SourceFile } from "@/domain/artifact/sourceFile";
import { AudioJobStepError, type AudioJobProcessorDeps } from "./processJob";

/** A durable cleaning stage follows successful delivery; originals are never indexed as derived files. */
export function createAudioCleanup(deps: SourceFileDeps): AudioJobProcessorDeps["clean"] {
  return async (job, context) => {
    const kinds: NonNullable<SourceFile["derived"]>["kind"][] = ["checkpoint", ...(job.movedTo ? ["transcript" as const, "draft" as const] : [])];
    for (const kind of kinds) {
      for (;;) {
        context.signal.throwIfAborted();
        const batch = await deps.files.forJob(job.projectName, job.id, kind, 100);
        if (!batch.length) break;
        for (const file of batch) {
          context.signal.throwIfAborted();
          if (file.projectName !== job.projectName || file.userEmail !== job.userEmail || file.derived?.jobId !== job.id || file.id === job.fileId) {
            throw new AudioJobStepError("cleanup_scope_invalid", false);
          }
          const now = deps.now().toISOString();
          const expired = file.retireAt <= now ? file : await deps.files.retire(file, now);
          if (!expired || !await removeExpiredSourceFile(deps, expired, now)) throw new AudioJobStepError("cleanup_conflict", true);
        }
      }
    }
  };
}
