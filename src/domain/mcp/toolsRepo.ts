/**
 * What one pull of the tools source repository holds.
 *
 * The mirror of `SkillsRepoSnapshot`, with one deliberate difference: a tool's
 * document is the whole of it. There are no attachments to collect, because a
 * registry entry is a pointer to a server, not content the model reads.
 */

/** One TOOL.md found in the tools repo. */
export interface RepoToolFile {
  /** Tool slug — the TOOL.md parent directory name. */
  name: string;
  path: string;
  content: string;
}

export interface ToolsRepoSnapshot {
  repo: string;
  branch: string;
  commitSha: string;
  files: RepoToolFile[];
  /** Directories holding a TOOL.md whose name is not a usable slug. */
  skippedPaths: string[];
}
