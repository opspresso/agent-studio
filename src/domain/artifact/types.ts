/**
 * What a run left behind.
 *
 * A run's bytes used to have no inventory. A generated image went to S3 under a
 * random UUID and its key was written into the chat message that happened to be
 * open, so nothing could list one, nothing could delete one, and a picture drawn
 * by a trigger or an A2A call went nowhere at all. An artifact row is that
 * missing inventory: one row per stored object, reachable by the project that
 * produced it and by the person who asked for it.
 *
 * Not to be confused with an A2A artifact, which is a protocol message part. The
 * `a2a` slice never imports this type.
 */

import type { RunActor } from "@/domain/execution/actor";

export type ArtifactKind = "image" | "document";

/** Whether the run produced these bytes or a person brought them. */
export type ArtifactSource = "generated" | "attachment";

export interface Artifact {
  artifactId: string;
  kind: ArtifactKind;
  source: ArtifactSource;
  /** The object key, derived from `artifactId` by {@link artifactObjectKey}. */
  key: string;
  mimeType: string;
  /** What the producer called the file. Documents have one; images rarely do. */
  filename?: string;
  byteSize: number;
  /** The project whose run bracket admitted this. Always present. */
  projectName: string;
  versionName: string;
  /**
   * Who caused the run, reusing the run's own attribution rather than restating
   * it: a usage row and an artifact row must not name the same run differently.
   * `caller` is deliberately absent — it is a display name, not a storage key.
   */
  actor?: RunActor;
  /**
   * Whose gallery this belongs in, when the surface knows a mailbox the actor
   * does not name.
   *
   * A Slack actor is a workspace id, so the owner index — which is keyed by
   * email — had nothing to key on, and a picture somebody asked the bot to draw
   * was reachable only through its project. The surface can resolve the address,
   * so it does, and files the output under the person who asked for it.
   *
   * Deliberately *not* folded into the actor. That is a storage key grouped by
   * surface, and a year of usage rows already reads `slack:U03FUG4UD`; it also
   * decides which tier's spend cap and concurrency limit a run answers to, and
   * an unregistered address resolves to `guest` — a change that belongs to a
   * different decision than "file this where its author can find it".
   */
  ownerEmail?: string;
  /** Project names on the transfer chain, outermost first. */
  ancestry?: readonly string[];
  /** The subagent that produced it, from the chunk's author. Absent at top level. */
  producedBy?: string;
  /** The bracket's correlation id — the one key that joins this to the logs. */
  runId?: string;
  /** What it was asked to make. Truncated by the writer. */
  prompt?: string;
  createdAt: string;
}

/**
 * The extension an object is stored under.
 *
 * Only the types this platform actually stores. Anything else keeps the object
 * addressable rather than guessing: `bin` says "these bytes are what they are"
 * where a wrong guess would say something false about them.
 */
const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/haansofthwpx": "hwpx",
  "application/vnd.hancom.hwpx": "hwpx",
  "application/x-hwp": "hwp",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "text/html": "html",
  "application/json": "json",
  "application/zip": "zip",
};

/**
 * Where an artifact's bytes live.
 *
 * Derived from `artifactId` rather than from a fresh random value, which is the
 * whole reason a row and an object can find each other: the legacy
 * `images/<uuid>` keys reference nothing, so an object orphaned by a failed
 * write could never be identified again. Split by kind because an S3 lifecycle
 * rule applies to a prefix — separating them later would mean moving objects.
 */
export function artifactObjectKey(
  kind: ArtifactKind,
  artifactId: string,
  mimeType: string,
): string {
  const extension = EXTENSIONS[mimeType.toLowerCase()] ?? "bin";
  return `artifacts/${kind}/${artifactId}.${extension}`;
}

/**
 * The person an artifact belongs to, or undefined when nobody is named.
 *
 * Only `user` and `project-token` carry an email — a token runs on its owner's
 * behalf. A Slack actor is a workspace id, but the surface can resolve the
 * asker's address and hands it in as `resolved`, which wins. A2A, webhook and
 * schedule actors identify a client or a trigger, not a mailbox, so those rows
 * are reachable through their project instead. That is why the owner index is
 * sparse and why the project index is not optional: without it those artifacts
 * could never be listed or deleted.
 */
export function artifactOwnerEmail(
  actor?: RunActor,
  /** What the surface resolved, when it knows an address the actor does not carry. */
  resolved?: string,
): string | undefined {
  if (resolved) {
    return resolved;
  }
  if (!actor) {
    return undefined;
  }
  return actor.kind === "user" || actor.kind === "project-token" ? actor.id : undefined;
}
