import type { SkippedAttachment } from "./files";

export interface SkillFile {
  /** Path relative to the skill root (the SKILL.md directory), e.g. "references/api.md". */
  path: string;
  content: string;
}

export interface Skill {
  name: string;
  description: string;
  content: string;
  /**
   * Attachment files loadable on demand via the Skill tool's `file_path` for
   * progressive disclosure. Absent for skills that are only a SKILL.md body.
   */
  files?: SkillFile[];
  /** Provenance marker for synced skills, e.g. "github:opspresso/agent-skills". */
  source?: string;
  createdAt: string;
  updatedAt: string;
}

/** One SKILL.md found in the skills repo, with its collected attachments. */
export interface RepoSkillFile {
  /** Skill slug — the SKILL.md parent directory name. */
  name: string;
  path: string;
  content: string;
  /** Supported attachment files under the skill root, by relative path. */
  files: SkillFile[];
}

/** One pull of the skills repo: what it held and what was skipped. */
export interface SkillsRepoSnapshot {
  repo: string;
  branch: string;
  commitSha: string;
  files: RepoSkillFile[];
  /** Attachment files skipped during collection, with reasons. */
  skipped: SkippedAttachment[];
}
