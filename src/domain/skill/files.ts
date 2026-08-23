import type { SkillFile } from "./types";

/**
 * Supported text attachment types. Executable scripts and binary assets are
 * intentionally excluded — the Skill tool only serves readable references.
 */
export const ALLOWED_SKILL_FILE_EXTENSIONS = [
  ".md",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".csv",
] as const;

/** Per-file byte cap; larger attachments are skipped at sync time. */
export const MAX_SKILL_FILE_BYTES = 64 * 1024;
/** Maximum attachment count per skill. */
export const MAX_SKILL_FILES = 20;
/** Combined attachment byte cap per skill (keeps the stored item well-bounded). */
export const MAX_SKILL_TOTAL_BYTES = 200 * 1024;

export function hasAllowedExtension(path: string): boolean {
  const lower = path.toLowerCase();
  return ALLOWED_SKILL_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export type PathReject = "empty" | "absolute" | "backslash" | "traversal";

/**
 * Normalize a caller-supplied relative path, rejecting anything that could
 * escape the skill root: absolute paths, backslashes, `..`, and empty/`.`
 * segments. Returns the cleaned `a/b/c` form on success.
 */
export function normalizeSkillFilePath(
  requested: string,
): { ok: true; path: string } | { ok: false; reason: PathReject } {
  const trimmed = requested.trim();
  if (trimmed === "") {
    return { ok: false, reason: "empty" };
  }
  if (trimmed.includes("\\")) {
    return { ok: false, reason: "backslash" };
  }
  if (trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed)) {
    return { ok: false, reason: "absolute" };
  }
  const segments = trimmed.split("/");
  for (const segment of segments) {
    if (segment === "..") {
      return { ok: false, reason: "traversal" };
    }
    if (segment === "" || segment === ".") {
      return { ok: false, reason: "empty" };
    }
  }
  return { ok: true, path: segments.join("/") };
}

export type SkillFileReject = "invalid-path" | "unsupported-type" | "not-found";

/**
 * Resolve a requested `file_path` against a skill's stored attachments. Stored
 * paths are already clean relative paths, so an exact match after normalization
 * cannot reach another skill or the filesystem.
 */
export function resolveSkillFile(
  files: SkillFile[],
  requested: string,
): { ok: true; content: string } | { ok: false; reason: SkillFileReject } {
  const normalized = normalizeSkillFilePath(requested);
  if (!normalized.ok) {
    return { ok: false, reason: "invalid-path" };
  }
  if (!hasAllowedExtension(normalized.path)) {
    return { ok: false, reason: "unsupported-type" };
  }
  const found = files.find((file) => file.path === normalized.path);
  if (!found) {
    return { ok: false, reason: "not-found" };
  }
  return { ok: true, content: found.content };
}

export function describeSkillFileReject(reason: SkillFileReject): string {
  switch (reason) {
    case "invalid-path":
      return "the path is invalid — use a relative path within the skill, without '..' or a leading '/'";
    case "unsupported-type":
      return `the file type is not supported (allowed: ${ALLOWED_SKILL_FILE_EXTENSIONS.join(", ")})`;
    case "not-found":
      return "no such file exists in this skill";
  }
}

export interface SkillTreeEntry {
  path: string;
  type: string;
  mode?: string;
  size?: number;
  sha: string;
}

export interface SkillRoot {
  name: string;
  /** Directory holding SKILL.md, e.g. "skills/greeting". */
  rootPath: string;
  /** Full path of the SKILL.md itself. */
  skillMdPath: string;
}

export type AttachmentSkip =
  | "symlink"
  | "unsupported-type"
  | "too-large"
  | "count-limit"
  | "size-limit";

export interface SelectedAttachment {
  name: string;
  relPath: string;
  sha: string;
}

export interface SkippedAttachment {
  name: string;
  path: string;
  reason: AttachmentSkip;
}

/** git's mode for a symlink — the one entry type the attachment collector refuses outright. */
export const SYMLINK_MODE = "120000";

/**
 * Decide which tree blobs become attachments for each skill root, applying the
 * type/size/count caps and recording every skip with its reason. Files are
 * assigned to the longest matching root so a nested skill claims its own files.
 * Enforced over tree metadata (git reports blob size), so no blob is fetched
 * for a file that will be skipped.
 */
export function selectSkillAttachments(
  entries: SkillTreeEntry[],
  roots: SkillRoot[],
): { selected: SelectedAttachment[]; skipped: SkippedAttachment[] } {
  const rootsByDepth = [...roots].sort((a, b) => b.rootPath.length - a.rootPath.length);
  const skillMdPaths = new Set(roots.map((root) => root.skillMdPath));
  const candidatesByRoot = new Map<string, SkillTreeEntry[]>();

  for (const entry of entries) {
    if (entry.type !== "blob" || skillMdPaths.has(entry.path)) {
      continue;
    }
    const root = rootsByDepth.find((candidate) =>
      entry.path.startsWith(`${candidate.rootPath}/`),
    );
    if (!root) {
      continue;
    }
    const list = candidatesByRoot.get(root.name) ?? [];
    list.push(entry);
    candidatesByRoot.set(root.name, list);
  }

  const selected: SelectedAttachment[] = [];
  const skipped: SkippedAttachment[] = [];

  for (const root of roots) {
    const candidates = (candidatesByRoot.get(root.name) ?? []).sort((a, b) =>
      a.path.localeCompare(b.path),
    );
    let count = 0;
    let total = 0;
    for (const entry of candidates) {
      const relPath = entry.path.slice(root.rootPath.length + 1);
      const size = entry.size ?? 0;
      const skip = (reason: AttachmentSkip): void => {
        skipped.push({ name: root.name, path: relPath, reason });
      };
      if (entry.mode === SYMLINK_MODE) {
        skip("symlink");
      } else if (!hasAllowedExtension(entry.path)) {
        skip("unsupported-type");
      } else if (size > MAX_SKILL_FILE_BYTES) {
        skip("too-large");
      } else if (count >= MAX_SKILL_FILES) {
        skip("count-limit");
      } else if (total + size > MAX_SKILL_TOTAL_BYTES) {
        skip("size-limit");
      } else {
        selected.push({ name: root.name, relPath, sha: entry.sha });
        count += 1;
        total += size;
      }
    }
  }

  return { selected, skipped };
}
