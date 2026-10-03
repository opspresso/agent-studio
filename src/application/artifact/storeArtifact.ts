/** Inventory generated/attached outputs and existing private files with their provenance. */

import { randomUUID } from "node:crypto";
import type { ArtifactObjectStore } from "@/domain/artifact/objectStore";
import type { ArtifactRepository } from "@/domain/artifact/repository";
import { artifactObjectKey, artifactOwnerEmail } from "@/domain/artifact/types";
import type { Artifact, ArtifactKind, ArtifactSource } from "@/domain/artifact/types";
import type { RunActor } from "@/domain/execution/actor";
import type { SourceFile } from "@/domain/artifact/sourceFile";
import { isSourceArtifact, sourceFileObjectKey } from "@/domain/artifact/sourceFile";
import type { ArtifactContentRepository } from "@/domain/artifact/contentRepository";
import { artifactContentKey, contentChecksum } from "./contentIdentity";
import { cutCodePoints } from "@/shared/utf8Text";
import { ConflictError, isTransactionCancelled } from "@/application/errors";

/**
 * How much of the instruction is kept beside the bytes.
 *
 * A prompt is what makes a gallery legible — "which one was the poster?" — but
 * it is also user text living for the row's whole retention window, past the
 * chat message that carried it. Enough to recognise the picture, not a copy of
 * the conversation.
 */
export const MAX_ARTIFACT_PROMPT_CHARS = 500;

/** Index an already stored private file without copying its bytes or extending retention. */
export async function registerSourceArtifact(rows: ArtifactRepository, file: SourceFile): Promise<void> {
  if (file.status !== "ready" || !isSourceArtifact(file)) return;
  try { await rows.put({ artifactId: file.id, privateFileId: file.id, retireAt: file.retireAt,
    ...(file.derivedFrom ? { derivedFrom: file.derivedFrom } : {}), ...(file.model ? { model: file.model } : {}),
    producedBy: file.producedBy ?? file.agentName,
    kind: file.mimeType.startsWith("audio/") ? "audio" : "document",
    source: file.derived ? "generated" : "attachment", key: sourceFileObjectKey(file.id),
    mimeType: file.mimeType, filename: file.filename, byteSize: file.byteSize!,
    checksum: file.checksum,
    agentName: file.agentName, ownerEmail: file.userEmail,
    createdAt: file.storedAt ?? file.createdAt }); }
  catch (error) {
    if (isTransactionCancelled(error)) throw new ConflictError("Private file changed or expired before Artifact registration");
    throw error;
  }
}

/** The two ports an artifact needs, wired or absent together. */
export interface ArtifactStorage {
  rows: ArtifactRepository;
  objects: ArtifactObjectStore;
  content: ArtifactContentRepository;
}

/** What the run already knows, bound once by the bracket that opened it. */
export interface ArtifactContext {
  agentName: string;
  actor?: RunActor;
  /** The mailbox this run's output belongs to, when the surface knows one. */
  ownerEmail?: string;
  ancestry?: readonly string[];
  runId?: string;
}

/** Reserve an output identity before the run bracket stores its bytes. */
export function createArtifactId(): string { return randomUUID(); }

export interface ArtifactInput {
  artifactId?: string;
  derivedFrom?: string;
  kind: ArtifactKind;
  source: ArtifactSource;
  bytes: Uint8Array;
  mimeType: string;
  filename?: string;
  prompt?: string;
  /** The subagent that produced it, from the chunk's author. */
  producedBy?: string;
  /** Transfer path that produced it, relative to the bracket's root agent. */
  authorPath?: readonly string[];
  /** The model that drew it, from the chunk. Absent when nothing can name one. */
  model?: string;
}

/** One metadata shape for private run drafts and stored artifacts. */
export function artifactMetadata(
  context: ArtifactContext,
  input: ArtifactInput,
): Artifact {
  const artifactId = input.artifactId ?? createArtifactId();
  const key = artifactObjectKey(input.kind, artifactId, input.mimeType);
  const prompt = input.prompt ? cutCodePoints(input.prompt, MAX_ARTIFACT_PROMPT_CHARS) : undefined;
  const ancestry = input.authorPath?.length
    ? [...(context.ancestry ?? [context.agentName]), ...input.authorPath]
    : context.ancestry;
  const artifact: Artifact = {
    artifactId,
    ...(input.derivedFrom ? { derivedFrom: input.derivedFrom } : {}),
    kind: input.kind,
    source: input.source,
    key,
    mimeType: input.mimeType,
    ...(input.filename ? { filename: input.filename } : {}),
    byteSize: input.bytes.byteLength,
    checksum: contentChecksum(input.bytes),
    agentName: context.agentName,
    ...(context.actor ? { actor: context.actor } : {}),
    ...(context.ownerEmail ? { ownerEmail: context.ownerEmail } : {}),
    ...(ancestry?.length ? { ancestry } : {}),
    ...(input.producedBy ? { producedBy: input.producedBy } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(context.runId ? { runId: context.runId } : {}),
    ...(prompt ? { prompt } : {}),
    createdAt: new Date().toISOString(),
  };
  return artifact;
}

export async function storeArtifact(
  storage: ArtifactStorage,
  context: ArtifactContext,
  input: ArtifactInput,
): Promise<Artifact> {
  return (await writeArtifact(storage, context, input)).artifact;
}

interface ArtifactWriteResult {
  artifact: Artifact;
  replacedArtifactId?: string;
  cleanupFailure?: { error: unknown };
}

/** Store the replacement before removing the caller's previous generated file. Uploaded inputs remain inputs. */
export function replaceGeneratedArtifact(storage: ArtifactStorage, context: ArtifactContext, input: ArtifactInput, sourceId: string): Promise<ArtifactWriteResult> {
  return writeArtifact(storage, context, input, sourceId);
}

/** Acquire all content/identity locks together; nested lock acquisition can exhaust the dedicated pool. */
async function writeArtifact(storage: ArtifactStorage, context: ArtifactContext, input: ArtifactInput, sourceId?: string): Promise<ArtifactWriteResult> {
  const artifact = artifactMetadata(context, input);
  const { artifactId, key } = artifact;
  const contentKey = artifactContentKey(artifact, artifact.checksum!);
  const source = sourceId ? await storage.rows.get(sourceId) : null;
  const locks = [`artifact-id:${artifactId}`, contentKey,
    ...(sourceId ? [`artifact-id:${sourceId}`] : []),
    ...(source?.checksum ? [artifactContentKey(source, source.checksum)] : [])];
  return storage.content.exclusive(locks, async () => {
    let previous: Artifact | null = null;
    if (sourceId) {
      const current = await storage.rows.get(sourceId);
      const owner = artifactOwnerEmail(context.actor, context.ownerEmail);
      if (!source || !current || current.artifactId !== sourceId || current.privateFileId || !owner ||
          artifactOwnerEmail(current.actor, current.ownerEmail) !== owner ||
          current.key !== source.key || current.checksum !== source.checksum) {
        throw new ConflictError("The source file is no longer available for replacement");
      }
      previous = current;
    }
    const stored = await store();
    if (previous?.source === "generated" && previous.artifactId !== stored.artifactId) {
      try {
        await storage.objects.delete(previous.key);
        await storage.rows.delete(previous.artifactId);
        return { artifact: stored, replacedArtifactId: previous.artifactId };
      } catch (error) { return { artifact: stored, cleanupFailure: { error } }; }
    }
    return { artifact: stored };
  });

  async function store(): Promise<Artifact> {
    const occupied = await storage.rows.get(artifactId);
    if (occupied) {
      if (!occupied.checksum || occupied.checksum !== artifact.checksum || artifactContentKey(occupied, occupied.checksum) !== contentKey) {
        throw new ConflictError("Artifact identity already contains different content");
      }
      await storage.content.put(contentKey, { id: occupied.artifactId, kind: "artifact" });
      return occupied;
    }
    const reference = await storage.content.get(contentKey);
    const existing = reference?.kind === "artifact" ? await storage.rows.get(reference.id) : null;
    if (existing) {
      if (input.artifactId && input.artifactId !== existing.artifactId) {
        await storage.rows.put({ ...existing, artifactId: input.artifactId, canonicalArtifactId: existing.artifactId });
      }
      return existing;
    }
    await storage.objects.put({ key, bytes: input.bytes, mimeType: input.mimeType });
    await storage.rows.put(artifact);
    await storage.content.put(contentKey, { id: artifactId, kind: "artifact" });
    return artifact;
  }
}
