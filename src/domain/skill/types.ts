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
  /**
   * Provenance marker for synced skills, e.g.
   * "github:opspresso/agent-plugins#devops" — the repo and the plugin that
   * declared it. Absent for a skill someone wrote in the console.
   */
  source?: string;
  createdAt: string;
  updatedAt: string;
}
