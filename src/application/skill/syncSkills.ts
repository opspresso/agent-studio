import type { SkillFile, SkillsRepoSnapshot } from "@/domain/skill/types";
import type { SkillRepository } from "@/domain/skill/repository";
import type { SkillUseCases } from "./skillUseCases";
import { firstHeadingOrLine, parseFrontmatter } from "@/shared/frontmatter";
import type {
  RepoSyncResult,
  SyncExisting,
  SyncSelection,
} from "@/domain/sync/types";

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

/** An empty attachment set and an absent one are the same skill. */
function sameFiles(a: SkillFile[] | undefined, b: SkillFile[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) {
    return false;
  }
  return left.every((file, index) => {
    const other = right[index];
    return other !== undefined && file.path === other.path && file.content === other.content;
  });
}

/**
 * Pull the skills repository into the registry.
 *
 * **A sync imports what is missing and reports everything else.** This used to
 * upsert unconditionally on the reasoning that a skill row is entirely
 * reconstructible from its document — true of the row, but not of the decision:
 * an admin who edited a skill in the console had that edit silently reverted on
 * the next pull, with nothing to say it had happened. So an existing name is
 * left alone and reported with what the document would replace, and only a
 * caller naming it in `overwrite` changes it. Tools work the same way, and
 * reading either report is the same job.
 *
 * A skill this sync created that the repository no longer carries is reported as
 * `orphaned`, never deleted; skills someone wrote in the console are not listed,
 * because they were never the repository's to miss.
 */
export async function syncSkillsFromSnapshot(
  repo: SkillRepository,
  /**
   * Deletion goes through the use case even though every write here goes
   * straight to the repository. The asymmetry is the point: a skill document has
   * nothing to check on the way in — no URL to guard, no header to encrypt,
   * which is why the tools sync needs its use cases and this one did not — but
   * `remove` is the single owner of the `registry.delete` row. Deleting through
   * the repository left a skill removed by a sync with no trace at all, while
   * the same removal from the console left one.
   */
  skills: Pick<SkillUseCases, "remove">,
  snapshot: SkillsRepoSnapshot,
  /** Who asked for the sync; a deletion it performs is recorded against them. */
  actorEmail: string,
  selection: SyncSelection = {},
): Promise<RepoSyncResult> {
  const source = `github:${snapshot.repo}`;
  const overwrite = new Set(selection.overwrite ?? []);
  const remove = new Set(selection.remove ?? []);
  const now = new Date().toISOString();

  const created: string[] = [];
  const existing: SyncExisting[] = [];
  const overwritten: string[] = [];
  const orphaned: string[] = [];
  const removed: string[] = [];

  const inRepo = new Set(snapshot.files.map((file) => file.name));

  for (const file of snapshot.files) {
    const { description, body } = parseSkillDoc(file.content);
    const files = file.files.length > 0 ? file.files : undefined;
    const current = await repo.get(file.name);
    const write = async (createdAt: string) => {
      await repo.put({
        name: file.name,
        description,
        content: body,
        files,
        source,
        createdAt,
        updatedAt: now,
      });
    };

    if (!current) {
      await write(now);
      created.push(file.name);
      continue;
    }

    const differs: string[] = [
      ...(current.description !== description ? ["description"] : []),
      ...(current.content !== body ? ["content"] : []),
      ...(sameFiles(current.files, files) ? [] : ["files"]),
    ];
    if (!overwrite.has(file.name) || differs.length === 0) {
      // Nothing is written for an entry the caller did not name — and nothing
      // for one that already agrees either, or `updatedAt` would move on every
      // sync and make the registry look edited.
      existing.push({ name: file.name, differs });
      continue;
    }
    await write(current.createdAt);
    overwritten.push(file.name);
  }

  for (const skill of await repo.list()) {
    if (skill.source !== source || inRepo.has(skill.name)) {
      continue;
    }
    if (!remove.has(skill.name)) {
      orphaned.push(skill.name);
      continue;
    }
    await skills.remove(skill.name, actorEmail);
    removed.push(skill.name);
  }

  return {
    repo: snapshot.repo,
    commitSha: snapshot.commitSha,
    created,
    existing,
    overwritten,
    orphaned,
    removed,
    // An attachment the collector refused is a skill that carries less than its
    // document says. Named by the skill, because that is what an operator looks
    // up, with the file and the reason alongside.
    skipped: snapshot.skipped.map((attachment) => ({
      name: attachment.name,
      reason: "attachment" as const,
      detail: `${attachment.path}: ${attachment.reason}`,
    })),
  };
}
