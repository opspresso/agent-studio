import type { Skill, SkillFile, SkillsRepoSnapshot } from "@/domain/skill/types";
import type { SkillRepository } from "@/domain/skill/repository";
import type { SkippedAttachment } from "@/domain/skill/files";
import { firstHeadingOrLine, parseFrontmatter } from "@/shared/frontmatter";

export interface ParsedSkillDoc {
  description: string;
  body: string;
}

/**
 * Parse a SKILL.md document: the frontmatter block's `description` names the
 * skill, and the remainder is the content the model loads.
 */
export function parseSkillDoc(raw: string): ParsedSkillDoc {
  const { fields, body } = parseFrontmatter(raw);
  return { description: fields.description ?? firstHeadingOrLine(body), body };
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
