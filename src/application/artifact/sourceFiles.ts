import { createHash } from "node:crypto";
import type { SourceFile, SourceFileRepository } from "@/domain/artifact/sourceFile";
import { sourceFileObjectKey } from "@/domain/artifact/sourceFile";
import { SourceObjectExistsError, type SourceObjectStore } from "@/domain/artifact/sourceObjectStore";
import { ConflictError, NotFoundError, ValidationError } from "@/application/errors";
import { fileExpiresAt } from "./fileRetention";

const MAX_SOURCE_BYTES = 512 * 1024 * 1024;
const INCOMPLETE_UPLOAD_MS = 24 * 60 * 60 * 1000;

export interface SourceFileDeps {
  files: SourceFileRepository;
  objects: SourceObjectStore;
  now(): Date;
}

function assertReadable(file: SourceFile | null, userEmail: string, now: string): asserts file is SourceFile {
  if (!file || file.userEmail !== userEmail) throw new NotFoundError("Source file not found");
  if (file.status !== "ready" || file.retireAt <= now) throw new ConflictError("Source file is unavailable or expired");
}

export function createSourceFileUseCases(deps: SourceFileDeps) {
  const storedReceipt = async (file: SourceFile) => {
    const recovered = await deps.objects.read(sourceFileObjectKey(file.id), MAX_SOURCE_BYTES);
    if (recovered.mimeType !== file.mimeType) throw new ConflictError("Source object type does not match its inventory");
    return { byteSize: recovered.bytes.byteLength, checksum: createHash("sha256").update(recovered.bytes).digest("hex") };
  };
  const recoverCompletedUpload = async (file: SourceFile): Promise<SourceFile | null> => {
    const existing = await deps.objects.stat(sourceFileObjectKey(file.id));
    if (!existing) return null;
    const receipt = await storedReceipt(file);
    return deps.files.finish(file, { ...receipt, storedAt: existing.storedAt,
      retireAt: fileExpiresAt(existing.storedAt, file.retention) });
  };
  return {
    async import(input: Pick<SourceFile, "id" | "projectName" | "userEmail" | "filename" | "mimeType" | "retention">,
      open: () => Promise<AsyncIterable<Uint8Array>>, signal?: AbortSignal): Promise<SourceFile> {
      signal?.throwIfAborted();
      if (!input.id || !input.filename.trim() || input.filename.length > 255 || !input.mimeType ||
        !input.userEmail || /[\r\n\0]/.test(input.filename)) throw new ValidationError("Source file metadata is invalid");
      const now = deps.now();
      // Validate retention before creating inventory or opening a remote source.
      fileExpiresAt(now.toISOString(), input.retention);
      let file = await deps.files.create({ ...input, status: "pending", revision: 1, createdAt: now.toISOString(),
        retireAt: new Date(now.getTime() + INCOMPLETE_UPLOAD_MS).toISOString() });
      if (file.userEmail !== input.userEmail) throw new NotFoundError("Source file not found");
      if (file.status === "pending" && file.retireAt <= now.toISOString()) {
        file = await recoverCompletedUpload(file) ?? file;
      }
      if (file.status === "ready") { assertReadable(file, input.userEmail, now.toISOString()); return file; }
      if (file.status !== "pending" || file.retireAt <= now.toISOString()) throw new ConflictError("Source file is unavailable or expired");
      const key = sourceFileObjectKey(file.id);
      let receipt: { byteSize: number; checksum: string } | undefined;
      let existing = await deps.objects.stat(key);
      if (!existing) {
        try {
          receipt = await deps.objects.write({ key, body: await open(), mimeType: file.mimeType, maxBytes: MAX_SOURCE_BYTES }, signal);
        } catch (error) {
          if (!(error instanceof SourceObjectExistsError)) throw error;
        }
        existing = await deps.objects.stat(key);
      }
      if (!existing) throw new ConflictError("Uploaded source object is not available");
      if (!receipt) receipt = await storedReceipt(file);
      if (existing.byteSize !== receipt.byteSize || existing.mimeType !== file.mimeType) {
        throw new ConflictError("Source object metadata does not match its receipt");
      }
      const finished = await deps.files.finish(file, { ...receipt, storedAt: existing.storedAt,
        retireAt: fileExpiresAt(existing.storedAt, file.retention) });
      if (finished) return finished;
      const latest = await deps.files.get(file.projectName, file.id);
      if (latest?.status === "deleting" || latest?.status === "deleted") await deps.objects.delete(key);
      assertReadable(latest, input.userEmail, deps.now().toISOString());
      return latest;
    },

    async read(projectName: string, id: string, userEmail: string, maxBytes = MAX_SOURCE_BYTES) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_SOURCE_BYTES) throw new ValidationError("Invalid source read limit");
      const file = await deps.files.get(projectName, id);
      assertReadable(file, userEmail, deps.now().toISOString());
      const result = await deps.objects.read(sourceFileObjectKey(id), maxBytes);
      assertReadable(file, userEmail, deps.now().toISOString());
      return { file, ...result };
    },

    async sweep(limit = 100): Promise<{ deleted: number; failed: number }> {
      const now = deps.now().toISOString();
      const result = { deleted: 0, failed: 0 };
      for (let file of await deps.files.expired(now, limit)) {
        try {
          // Pending inventory may outlive a completed upload whose response was lost.
          if (file.status === "pending") {
            const recovered = await recoverCompletedUpload(file);
            if (recovered) file = recovered;
          }
          if (file.retireAt > now) continue;
          const deleting = await deps.files.markDeleting(file, now);
          if (!deleting) continue;
          await deps.objects.delete(sourceFileObjectKey(file.id));
          if (await deps.files.markDeleted(deleting, now)) result.deleted += 1;
        } catch { result.failed += 1; }
      }
      return result;
    },
  };
}
