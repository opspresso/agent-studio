import { createHash } from "node:crypto";
import type { SourceFile, SourceFileRepository } from "@/domain/artifact/sourceFile";
import { sourceFileObjectKey } from "@/domain/artifact/sourceFile";
import { SourceObjectExistsError, type SourceObjectStore } from "@/domain/artifact/sourceObjectStore";
import type { SourceByteStream } from "@/domain/artifact/sourceReference";
import { ConflictError, NotFoundError, ValidationError } from "@/application/errors";
import { fileExpiresAt } from "./fileRetention";

const MAX_SOURCE_BYTES = 512 * 1024 * 1024;
const INCOMPLETE_UPLOAD_MS = 24 * 60 * 60 * 1000;

export interface SourceFileDeps {
  files: SourceFileRepository;
  objects: SourceObjectStore;
  now(): Date;
  publish?: (file: SourceFile) => Promise<void>;
}

function assertReadable(file: SourceFile | null, userEmail: string, now: string): asserts file is SourceFile {
  if (!file || file.userEmail !== userEmail) throw new NotFoundError("Source file not found");
  if (file.status !== "ready" || file.retireAt <= now) throw new ConflictError("Source file is unavailable or expired");
}

export async function removeExpiredSourceFile(deps: SourceFileDeps, file: SourceFile, now: string): Promise<boolean> {
  const deleting = await deps.files.markDeleting(file, now);
  if (!deleting) return false;
  await deps.objects.delete(sourceFileObjectKey(file.id));
  return deps.files.markDeleted(deleting, now);
}

export function createSourceFileUseCases(deps: SourceFileDeps) {
  const publish = async (file: SourceFile) => { await deps.publish?.(file); return file; };
  const expiry = (storedAt: string, file: Pick<SourceFile, "retention" | "retainUntil">) => {
    const policyExpiry = fileExpiresAt(storedAt, file.retention);
    return file.retainUntil && file.retainUntil < policyExpiry ? file.retainUntil : policyExpiry;
  };
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
      retireAt: expiry(existing.storedAt, file) });
  };
  return {
    async metadata(projectName: string, id: string, userEmail: string): Promise<SourceFile> {
      const file = await deps.files.get(projectName, id);
      if (!file || file.userEmail !== userEmail) throw new NotFoundError("Source file not found");
      return file;
    },
    async import(input: Pick<SourceFile, "id" | "projectName" | "userEmail" | "filename" | "mimeType" | "retention" | "retainUntil" | "derived" | "derivedFrom" | "model" | "producedBy">,
      open: (maxBytes: number) => Promise<SourceByteStream>, signal?: AbortSignal): Promise<SourceFile> {
      signal?.throwIfAborted();
      if (!input.id || !input.filename.trim() || input.filename.length > 255 || !input.mimeType ||
        !input.userEmail || /[\r\n\0]/.test(input.filename)) throw new ValidationError("Source file metadata is invalid");
      const now = deps.now();
      if (input.retainUntil !== undefined && (!Number.isFinite(Date.parse(input.retainUntil)) ||
        new Date(input.retainUntil).toISOString() !== input.retainUntil)) throw new ValidationError("Invalid source retention deadline");
      if (input.retainUntil !== undefined && input.retainUntil <= now.toISOString()) throw new ConflictError("Source retention deadline has passed");
      // Validate retention before creating inventory or opening a remote source.
      fileExpiresAt(now.toISOString(), input.retention);
      const uploadDeadline = new Date(now.getTime() + INCOMPLETE_UPLOAD_MS).toISOString();
      let file = await deps.files.create({ ...input, status: "pending", revision: 1, createdAt: now.toISOString(),
        retireAt: input.retainUntil && input.retainUntil < uploadDeadline ? input.retainUntil : uploadDeadline });
      if (file.userEmail !== input.userEmail) throw new NotFoundError("Source file not found");
      if (file.status === "pending" && file.retireAt <= now.toISOString()) {
        file = await recoverCompletedUpload(file) ?? file;
      }
      if (file.status === "ready") { assertReadable(file, input.userEmail, now.toISOString()); return publish(file); }
      if (file.status !== "pending" || file.retireAt <= now.toISOString()) throw new ConflictError("Source file is unavailable or expired");
      const key = sourceFileObjectKey(file.id);
      let receipt: { byteSize: number; checksum: string } | undefined;
      let existing = await deps.objects.stat(key);
      if (!existing) {
        const body = await open(MAX_SOURCE_BYTES);
        try {
          receipt = await deps.objects.write({ key, body, mimeType: file.mimeType, maxBytes: MAX_SOURCE_BYTES }, signal);
        } catch (error) {
          if (!(error instanceof SourceObjectExistsError)) throw error;
        } finally { await body.close?.().catch(() => {}); }
        existing = await deps.objects.stat(key);
      }
      if (!existing) throw new ConflictError("Uploaded source object is not available");
      if (!receipt) receipt = await storedReceipt(file);
      if (existing.byteSize !== receipt.byteSize || existing.mimeType !== file.mimeType) {
        throw new ConflictError("Source object metadata does not match its receipt");
      }
      const finished = await deps.files.finish(file, { ...receipt, storedAt: existing.storedAt,
        retireAt: expiry(existing.storedAt, file) });
      if (finished) { assertReadable(finished, input.userEmail, deps.now().toISOString()); return publish(finished); }
      const latest = await deps.files.get(file.projectName, file.id);
      if (latest?.status === "deleting" || latest?.status === "deleted") await deps.objects.delete(key);
      assertReadable(latest, input.userEmail, deps.now().toISOString());
      return publish(latest);
    },

    async read(projectName: string, id: string, userEmail: string, maxBytes = MAX_SOURCE_BYTES) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_SOURCE_BYTES) throw new ValidationError("Invalid source read limit");
      const file = await deps.files.get(projectName, id);
      assertReadable(file, userEmail, deps.now().toISOString());
      const result = await deps.objects.read(sourceFileObjectKey(id), maxBytes);
      const latest = await deps.files.get(projectName, id);
      assertReadable(latest, userEmail, deps.now().toISOString());
      return { file: latest, ...result };
    },

    async remove(projectName: string, id: string, userEmail: string): Promise<void> {
      const file = await deps.files.get(projectName, id);
      if (!file || file.userEmail !== userEmail) throw new NotFoundError("Source file not found");
      if (file.status === "deleted") return;
      const now = deps.now().toISOString();
      const retired = await deps.files.retire(file, now);
      if (!retired || !await removeExpiredSourceFile(deps, retired, now)) throw new ConflictError("Source file changed; retry removal");
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
          if (await removeExpiredSourceFile(deps, file, now)) result.deleted += 1;
        } catch { result.failed += 1; }
      }
      return result;
    },
  };
}
