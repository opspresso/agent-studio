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
  /**
   * The model that drew these bytes, named by whichever producer made them.
   *
   * Carried on the chunk rather than derived from the run's version, because a
   * run's model is not what drew the picture: the builtins draw with the image
   * model `resolveImageModel` chose, and an image subagent draws with its own
   * version's. Filling this in at the bracket would put the parent's model on a
   * child's work and never say so.
   *
   * Absent whenever nothing can honestly name one — an attachment somebody
   * brought, a document a tool rendered, a picture an MCP tool or a remote A2A
   * agent handed back. Empty is the true answer there, not a guess.
   */
  model?: string;
  /** The bracket's correlation id — the one key that joins this to the logs. */
  runId?: string;
  /** What it was asked to make. Truncated by the writer. */
  prompt?: string;
  createdAt: string;
}

/**
 * A mime type without its parameters, which is the form every rule below is
 * written against: `text/html; charset=euc-kr` is `text/html`.
 *
 * One function rather than the copy each predicate was carrying, because they
 * have to agree — a type that {@link isSavable} admits with a parameter
 * attached and {@link artifactObjectKey} then matches exactly is stored as
 * `.bin`, and served back with two charsets in one header.
 */
export function baseMimeType(mimeType: string): string {
  return mimeType.split(";")[0]!.trim().toLowerCase();
}

/**
 * How a stored artifact reaches a screen, when it can.
 *
 * Two entries and two different answers, which is why this is a kind rather
 * than a yes. `html` is served as it was written — running somebody's markup is
 * exactly what a sandbox is for, and being worth one is what earns a place
 * here. `markdown` has nothing to run: the app renders it into a page, so what
 * the reader gets is markup this app produced from the text, and it can be held
 * to a stricter policy than the case that needs scripts.
 *
 * The list stays short because the question is not "can a browser display
 * this". A PDF the browser draws on its own never needed a sandbox, and a
 * `.docx` it saves does nothing on the way past — those stay downloads, which
 * ask for no trust at all.
 *
 * Read with the parameters stripped, because `text/html; charset=utf-8` is the
 * same type. It is not the same *stored* mime — {@link artifactObjectKey}
 * matches exactly, so a row written with the parameter attached is stored as
 * `.bin` — and producers write the bare type. Being forgiving here means such a
 * row is still viewable rather than silently a download.
 */
export type InlineView = "html" | "markdown";

const INLINE_VIEWS: Record<string, InlineView> = {
  "text/html": "html",
  "text/markdown": "markdown",
};

export function inlineViewOf(mimeType: string): InlineView | undefined {
  return INLINE_VIEWS[baseMimeType(mimeType)];
}

export function isInlineViewable(mimeType: string): boolean {
  return inlineViewOf(mimeType) !== undefined;
}

/**
 * What a run may write as a file, and the type it writes it as.
 *
 * Text only, and the reason is not caution about size. A model produces text;
 * anything else would arrive base64-encoded, which doubles what it costs to say
 * and puts the model in the business of encoding bytes it cannot check. The two
 * kinds of file this platform already produces come from things that make bytes
 * for a living — an image model, a document renderer — and neither is replaced
 * by this.
 *
 * Every entry is a type {@link artifactObjectKey} knows an extension for.
 * A type that is savable but has no extension would be stored as `.bin`, which
 * is a file nobody's machine can open by clicking it.
 */
export const SAVABLE_TYPES: readonly string[] = [
  "text/html",
  "text/markdown",
  "text/plain",
  "text/csv",
  "application/json",
  "image/svg+xml",
];

export function isSavable(mimeType: string): boolean {
  return SAVABLE_TYPES.includes(baseMimeType(mimeType));
}

/**
 * How much text one file may carry.
 *
 * Below {@link MAX_INLINE_VIEW_BYTES} deliberately: a page a run wrote must be
 * one this app can turn around and show, and two limits that can cross would
 * produce a file that was accepted and then cannot be opened. Far past any
 * report and far short of anything a model would finish writing anyway.
 */
export const MAX_SAVED_FILE_BYTES = 1024 * 1024;

/**
 * How much of an artifact a view may read into memory.
 *
 * Viewing is the one read that passes bytes through this app rather than handing
 * out an address, so it needs a ceiling the signed-URL paths never did. Two
 * megabytes is far past any page a run writes and far short of anything that
 * would matter to the process holding it.
 */
export const MAX_INLINE_VIEW_BYTES = 2 * 1024 * 1024;

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
  "image/svg+xml": "svg",
  "application/json": "json",
  "application/zip": "zip",
};

/**
 * The name a saved file is stored and downloaded under.
 *
 * A model names its own file, and a name from a model is text like any other:
 * it may carry a path, a control character, or nothing at all. What comes back
 * is a single segment — the last one, so `../../etc/passwd` is `passwd` — with
 * the extension its type implies, because the reader's machine opens a file by
 * its extension and a report called `report` opens in nothing.
 *
 * The name is not the identity: {@link artifactObjectKey} still derives the key
 * from the row id, so two files called the same thing are two objects. This only
 * decides what the reader's download is called.
 */
export function savedFileName(name: string, mimeType: string): string {
  const segment = name.split(/[/\\]/).pop() ?? "";
  const cleaned = segment
    // Control characters and the bytes Windows refuses in a name.
    .replace(/[\u0000-\u001f<>:"|?*]/g, "")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 80);
  const safe = cleaned === "" ? "file" : cleaned;
  const extension = EXTENSIONS[baseMimeType(mimeType)];
  if (!extension) {
    return safe;
  }
  // The suffix is named rather than inlined into the comparison: that shape is
  // what `tests/architecture.test.ts` watches for as a copy of the SSRF
  // host-suffix check, and a filename rule is not that rule.
  const suffix = `.${extension}`;
  return safe.toLowerCase().endsWith(suffix) ? safe : `${safe}${suffix}`;
}

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
