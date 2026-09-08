/**
 * The one place an artifact row is written.
 *
 * Every stored byte goes through here — a generated image, a rendered document,
 * an attachment a person brought — the way `recordAudit` is the only writer of
 * an audit row. A second writer would spell the provenance its own way, and a
 * gallery filtering on it would silently show nothing for half the rows.
 */

import { randomUUID } from "node:crypto";
import type { ArtifactObjectStore } from "@/domain/artifact/objectStore";
import type { ArtifactRepository } from "@/domain/artifact/repository";
import { artifactObjectKey } from "@/domain/artifact/types";
import type { Artifact, ArtifactKind, ArtifactSource } from "@/domain/artifact/types";
import type { RunActor } from "@/domain/execution/actor";
import { cutCodePoints } from "@/shared/utf8Text";

/**
 * How much of the instruction is kept beside the bytes.
 *
 * A prompt is what makes a gallery legible — "which one was the poster?" — but
 * it is also user text living for the row's whole retention window, past the
 * chat message that carried it. Enough to recognise the picture, not a copy of
 * the conversation.
 */
export const MAX_ARTIFACT_PROMPT_CHARS = 500;

/** The two ports an artifact needs, wired or absent together. */
export interface ArtifactStorage {
  rows: ArtifactRepository;
  objects: ArtifactObjectStore;
}

/** What the run already knows, bound once by the bracket that opened it. */
export interface ArtifactContext {
  projectName: string;
  versionName: string;
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
  /** Transfer path that produced it, relative to the bracket's root project. */
  authorPath?: readonly string[];
  /** The model that drew it, from the chunk. Absent when nothing can name one. */
  model?: string;
}

/**
 * Store the bytes, then record the row.
 *
 * **Object first, deliberately.** The reverse order can leave a row naming bytes
 * that were never written, which reads as an artifact whose preview is broken
 * forever; this order can only leave an object with no row, and the row is what
 * a caller is still holding when the write throws — so the caller reports the
 * loss rather than persisting a reference to nothing.
 */
export async function storeArtifact(
  storage: ArtifactStorage,
  context: ArtifactContext,
  input: ArtifactInput,
): Promise<Artifact> {
  const artifactId = input.artifactId ?? createArtifactId();
  const key = artifactObjectKey(input.kind, artifactId, input.mimeType);
  await storage.objects.put({ key, bytes: input.bytes, mimeType: input.mimeType });
  const prompt = input.prompt ? cutCodePoints(input.prompt, MAX_ARTIFACT_PROMPT_CHARS) : undefined;
  const artifact: Artifact = {
    artifactId,
    ...(input.derivedFrom ? { derivedFrom: input.derivedFrom } : {}),
    kind: input.kind,
    source: input.source,
    key,
    mimeType: input.mimeType,
    ...(input.filename ? { filename: input.filename } : {}),
    byteSize: input.bytes.byteLength,
    projectName: context.projectName,
    versionName: context.versionName,
    ...(context.actor ? { actor: context.actor } : {}),
    ...(context.ownerEmail ? { ownerEmail: context.ownerEmail } : {}),
    ...(context.ancestry && context.ancestry.length > 0 ? { ancestry: context.ancestry } : {}),
    ...(input.producedBy ? { producedBy: input.producedBy } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(context.runId ? { runId: context.runId } : {}),
    ...(prompt ? { prompt } : {}),
    createdAt: new Date().toISOString(),
  };
  await storage.rows.put(artifact);
  return artifact;
}
