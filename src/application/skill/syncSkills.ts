import type { Skill, SkillFile } from "@/domain/skill/types";
import type { SkillRepository } from "@/domain/skill/repository";
import type { SkippedAttachment } from "@/domain/skill/files";
import type { SkillsRepoSnapshot } from "@/infrastructure/github/skillsRepoClient";

export interface ParsedSkillDoc {
  description: string;
  body: string;
}

/**
 * Parse a SKILL.md document: an optional YAML frontmatter block provides the
 * description; the remainder is the skill content. Only flat `key: value`
 * frontmatter lines are recognized.
 */
export function parseSkillDoc(raw: string): ParsedSkillDoc {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match?.[1]) {
    return { description: firstHeadingOrLine(raw), body: raw.trim() };
  }
  const fields: Record<string, string> = {};
  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec((lines[i] ?? "").trim());
    if (!kv?.[1] || kv[2] === undefined) {
      continue;
    }
    let value = kv[2].replace(/^["']|["']$/g, "");
    // YAML folded/literal scalars (`key: >` or `key: |`): consume the
    // following indented lines and join them with spaces.
    if (value === ">" || value === "|" || value === ">-" || value === "|-") {
      const folded: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1] ?? "")) {
        folded.push((lines[i + 1] ?? "").trim());
        i += 1;
      }
      value = folded.join(" ");
    }
    fields[kv[1].toLowerCase()] = value;
  }
  const body = raw.slice(match[0].length).trim();
  return { description: fields.description ?? firstHeadingOrLine(body), body };
}

function firstHeadingOrLine(text: string): string {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  return firstLine.replace(/^#+\s*/, "").slice(0, 200);
}

export interface SyncResult {
  repo: string;
  commitSha: string;
  synced: string[];
  unchanged: number;
  /** Attachment files skipped during collection, with reasons. */
  skipped: SkippedAttachment[];
}

/** Normalize to a stable comparison form — an empty attachment set and an
 * absent one are equivalent. */
function normalizeFiles(files: SkillFile[] | undefined): SkillFile[] {
  return files ?? [];
}

function sameFiles(a: SkillFile[] | undefined, b: SkillFile[] | undefined): boolean {
  const left = normalizeFiles(a);
  const right = normalizeFiles(b);
  if (left.length !== right.length) {
    return false;
  }
  return left.every((file, index) => {
    const other = right[index];
    return other !== undefined && file.path === other.path && file.content === other.content;
  });
}

/** Upsert every SKILL.md in the snapshot, replacing each skill's attachment set.
 * GitHub is the source of truth for synced skills; locally-created skills
 * (different names) are untouched. Replacing the item drops stale attachments. */
export async function syncSkillsFromSnapshot(
  repo: SkillRepository,
  snapshot: SkillsRepoSnapshot,
): Promise<SyncResult> {
  const source = `github:${snapshot.repo}`;
  const now = new Date().toISOString();
  const synced: string[] = [];
  let unchanged = 0;

  for (const file of snapshot.files) {
    const { description, body } = parseSkillDoc(file.content);
    const files = file.files.length > 0 ? file.files : undefined;
    const existing = await repo.get(file.name);
    if (
      existing &&
      existing.description === description &&
      existing.content === body &&
      existing.source === source &&
      sameFiles(existing.files, files)
    ) {
      unchanged += 1;
      continue;
    }
    const skill: Skill = {
      name: file.name,
      description,
      content: body,
      files,
      source,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await repo.put(skill);
    synced.push(file.name);
  }

  return {
    repo: snapshot.repo,
    commitSha: snapshot.commitSha,
    synced,
    unchanged,
    skipped: snapshot.skipped,
  };
}
