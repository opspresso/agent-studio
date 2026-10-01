import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open as openFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SourceFile, SourceFileRepository } from "@/domain/artifact/sourceFile";
import { isSourceArtifact, sourceFileAvailability, sourceFileObjectKey } from "@/domain/artifact/sourceFile";
import type { ArtifactContentRepository } from "@/domain/artifact/contentRepository";
import { sourceContentKey } from "./contentIdentity";
import { savedFileName } from "@/domain/artifact/types";
import { SourceObjectExistsError, type SourceObjectStore } from "@/domain/artifact/sourceObjectStore";
import type { SourceByteStream } from "@/domain/artifact/sourceReference";
import { ConflictError, NotFoundError, ValidationError } from "@/application/errors";
import { fileExpiresAt } from "./fileRetention";

const MAX_SOURCE_BYTES = 512 * 1024 * 1024;
const INCOMPLETE_UPLOAD_MS = 24 * 60 * 60 * 1000;

export interface SourceFileDeps {
  files: SourceFileRepository;
  objects: SourceObjectStore;
  content: ArtifactContentRepository;
  now(): Date;
  publish?: (file: SourceFile) => Promise<void>;
  /** Deployment storage policy, checked before opening a source or spending a model call. */
  assertWritable?(): Promise<void>;
}

function assertReadable(file: SourceFile | null, userEmail: string, now: string): asserts file is SourceFile {
  if (!file || file.userEmail !== userEmail) throw new NotFoundError("Source file not found");
  if (sourceFileAvailability(file, userEmail, now) !== "ready") throw new ConflictError("Source file is unavailable or expired");
}

export async function removeExpiredSourceFile(deps: Pick<SourceFileDeps, "files" | "objects">, file: SourceFile, now: string): Promise<boolean> {
  const deleting = await deps.files.markDeleting(file, now);
  if (!deleting) return false;
  await deps.objects.delete(sourceFileObjectKey(file.id));
  return deps.files.markDeleted(deleting, now);
}

export function createSourceFileUseCases(deps: SourceFileDeps) {
  const publish = async (file: SourceFile) => { await deps.publish?.(file); return file; };
  const indexAndPublish = async (file: SourceFile): Promise<SourceFile> => {
    if (!isSourceArtifact(file) || !file.checksum) return publish(file);
    const contentKey = sourceContentKey(file, file.checksum);
    return deps.content.exclusive(contentKey, async () => {
      const reference = await deps.content.get(contentKey);
      const existing = reference?.kind === "source-file" ? await deps.files.get(file.agentName, reference.id) : null;
      if (existing && sourceFileAvailability(existing, file.userEmail, deps.now().toISOString()) === "ready") return publish(existing);
      await deps.content.put(contentKey, { id: file.id, kind: "source-file", expiresAt: file.retireAt });
      return publish(file);
    });
  };
  const expiry = (storedAt: string, file: Pick<SourceFile, "retention" | "retainUntil">) => {
    const policyExpiry = fileExpiresAt(storedAt, file.retention);
    return file.retainUntil && file.retainUntil < policyExpiry ? file.retainUntil : policyExpiry;
  };
  const storedReceipt = async (file: SourceFile, signal?: AbortSignal) => {
    const recovered = await deps.objects.read(sourceFileObjectKey(file.id), MAX_SOURCE_BYTES, signal);
    if (recovered.mimeType !== file.mimeType) throw new ConflictError("Source object type does not match its inventory");
    return { byteSize: recovered.bytes.byteLength, checksum: createHash("sha256").update(recovered.bytes).digest("hex") };
  };
  const recoverCompletedUpload = async (file: SourceFile, signal?: AbortSignal): Promise<SourceFile | null> => {
    const existing = await deps.objects.stat(sourceFileObjectKey(file.id), signal);
    if (!existing) return null;
    const receipt = await storedReceipt(file, signal);
    return deps.files.finish(file, { ...receipt, storedAt: existing.storedAt,
      retireAt: expiry(existing.storedAt, file) });
  };
  return {
    async metadata(agentName: string, id: string, userEmail: string): Promise<SourceFile> {
      const file = await deps.files.get(agentName, id);
      if (!file || file.userEmail !== userEmail) throw new NotFoundError("Source file not found");
      return file;
    },
    async import(input: Pick<SourceFile, "id" | "agentName" | "userEmail" | "filename" | "mimeType" | "retention" | "retainUntil" | "derived" | "derivedFrom" | "model" | "producedBy">,
      open: (maxBytes: number) => Promise<SourceByteStream>, signal?: AbortSignal): Promise<SourceFile> {
      signal?.throwIfAborted();
      await deps.assertWritable?.();
      if (!input.id || !input.filename.trim() || input.filename.length > 255 || !input.mimeType ||
        !input.userEmail || /[\r\n\0]/.test(input.filename)) throw new ValidationError("Source file metadata is invalid");
      const now = deps.now();
      if (input.retainUntil !== undefined && (!Number.isFinite(Date.parse(input.retainUntil)) ||
        new Date(input.retainUntil).toISOString() !== input.retainUntil)) throw new ValidationError("Invalid source retention deadline");
      if (input.retainUntil !== undefined && input.retainUntil <= now.toISOString()) throw new ConflictError("Source retention deadline has passed");
      // Validate retention before creating inventory or opening a remote source.
      fileExpiresAt(now.toISOString(), input.retention);
      const perform = async (producer: typeof open): Promise<SourceFile> => {
        const uploadDeadline = new Date(now.getTime() + INCOMPLETE_UPLOAD_MS).toISOString();
        let file = await deps.files.create({ ...input, filename: savedFileName(input.filename, input.mimeType),
          status: "pending", revision: 1, createdAt: now.toISOString(),
          retireAt: input.retainUntil && input.retainUntil < uploadDeadline ? input.retainUntil : uploadDeadline });
        if (file.userEmail !== input.userEmail) throw new NotFoundError("Source file not found");
        if (file.status === "pending" && file.retireAt <= now.toISOString()) {
          file = await recoverCompletedUpload(file, signal) ?? file;
        }
        if (file.status === "ready") { assertReadable(file, input.userEmail, now.toISOString()); return file; }
        if (file.status !== "pending" || file.retireAt <= now.toISOString()) throw new ConflictError("Source file is unavailable or expired");
        const key = sourceFileObjectKey(file.id);
        let receipt: { byteSize: number; checksum: string } | undefined;
        let existing = await deps.objects.stat(key, signal);
        if (!existing) {
          const body = await producer(MAX_SOURCE_BYTES);
          try {
            receipt = await deps.objects.write({ key, body, mimeType: file.mimeType, maxBytes: MAX_SOURCE_BYTES }, signal);
          } catch (error) {
            if (!(error instanceof SourceObjectExistsError)) throw error;
          } finally { await body.close?.().catch(() => {}); }
          existing = await deps.objects.stat(key, signal);
        }
        if (!existing) throw new ConflictError("Uploaded source object is not available");
        if (!receipt) receipt = await storedReceipt(file, signal);
        if (existing.byteSize !== receipt.byteSize || existing.mimeType !== file.mimeType) {
          throw new ConflictError("Source object metadata does not match its receipt");
        }
        const finished = await deps.files.finish(file, { ...receipt, storedAt: existing.storedAt,
          retireAt: expiry(existing.storedAt, file) });
        if (finished) { assertReadable(finished, input.userEmail, deps.now().toISOString()); return finished; }
        const latest = await deps.files.get(file.agentName, file.id);
        if (latest?.status === "deleting" || latest?.status === "deleted") await deps.objects.delete(key);
        assertReadable(latest, input.userEmail, deps.now().toISOString());
        return latest;
      };
      // Checkpoint identities must still avoid opening an expensive model producer on retries.
      const previous = await deps.files.get(input.agentName, input.id);
      if (previous && previous.userEmail !== input.userEmail) throw new NotFoundError("Source file not found");
      if (!isSourceArtifact(input) || previous?.status === "ready" || (previous && previous.status !== "pending")) {
        return indexAndPublish(await perform(open));
      }
      if (previous && previous.retireAt <= now.toISOString()) return indexAndPublish(await perform(open));
      if (previous && await deps.objects.stat(sourceFileObjectKey(previous.id), signal)) return indexAndPublish(await perform(open));
      await deps.files.assertWritable(input);
      // Hash bounded streams on private temporary disk before any persistent object is written.
      const directory = await mkdtemp(join(tmpdir(), "studio-source-"));
      const path = join(directory, "content");
      try {
        const staged = await openFile(path, "wx", 0o600);
        try {
          const body = await open(MAX_SOURCE_BYTES);
          try {
            const hash = createHash("sha256");
            let byteSize = 0;
            for await (const chunk of body) {
              signal?.throwIfAborted();
              byteSize += chunk.byteLength;
              if (byteSize > MAX_SOURCE_BYTES) throw new ValidationError("Source file exceeds storage limit");
              hash.update(chunk);
              let offset = 0;
              while (offset < chunk.byteLength) offset += (await staged.write(chunk, offset, chunk.byteLength - offset)).bytesWritten;
            }
            await staged.close();
            const contentKey = sourceContentKey(input, hash.digest("hex"));
            return await deps.content.exclusive(contentKey, async () => {
              signal?.throwIfAborted();
              await deps.files.assertWritable(input);
              const reference = await deps.content.get(contentKey);
              const existing = reference?.kind === "source-file" ? await deps.files.get(input.agentName, reference.id) : null;
              if (existing && sourceFileAvailability(existing, input.userEmail, deps.now().toISOString()) === "ready") return publish(existing);
              const stored = await perform(async () => (async function* () { yield* createReadStream(path); })());
              if (!stored.checksum || sourceContentKey(stored, stored.checksum) !== contentKey) {
                throw new ConflictError("Source file identity already contains different content or retention");
              }
              await deps.content.put(contentKey, { id: stored.id, kind: "source-file", expiresAt: stored.retireAt });
              return publish(stored);
            });
          } finally { await body.close?.(); }
        } finally { await staged.close(); }
      } finally { await rm(directory, { recursive: true, force: true }); }
    },

    async read(agentName: string, id: string, userEmail: string, maxBytes = MAX_SOURCE_BYTES, signal?: AbortSignal) {
      signal?.throwIfAborted();
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_SOURCE_BYTES) throw new ValidationError("Invalid source read limit");
      const file = await deps.files.get(agentName, id);
      assertReadable(file, userEmail, deps.now().toISOString());
      const result = await deps.objects.read(sourceFileObjectKey(id), maxBytes, signal);
      signal?.throwIfAborted();
      const latest = await deps.files.get(agentName, id);
      assertReadable(latest, userEmail, deps.now().toISOString());
      return { file: latest, ...result };
    },

    async remove(agentName: string, id: string, userEmail: string): Promise<void> {
      const file = await deps.files.get(agentName, id);
      if (!file || file.userEmail !== userEmail) throw new NotFoundError("Source file not found");
      if (file.status === "deleted") return;
      const now = deps.now().toISOString();
      const retired = await deps.files.retire(file, now);
      if (!retired || !await removeExpiredSourceFile(deps, retired, now)) throw new ConflictError("Source file changed; retry removal");
    },

    async sweep(limit = 100, signal?: AbortSignal): Promise<{ deleted: number; failed: number }> {
      signal?.throwIfAborted();
      const now = deps.now().toISOString();
      const result = { deleted: 0, failed: 0 };
      for (let file of await deps.files.expired(now, limit)) {
        signal?.throwIfAborted();
        try {
          // Pending inventory may outlive a completed upload whose response was lost.
          if (file.status === "pending") {
            const recovered = await recoverCompletedUpload(file, signal);
            if (recovered) file = recovered;
          }
          if (file.retireAt > now) continue;
          if (await removeExpiredSourceFile(deps, file, now)) result.deleted += 1;
        } catch { signal?.throwIfAborted(); result.failed += 1; }
      }
      return result;
    },
  };
}
