/**
 * What one pull of the plugins repository carries, and what a sync of it
 * reports. The report vocabulary (`SyncSkip`, `SyncExisting`) is shared with
 * the rest of the registry via `domain/sync/types.ts`; the shapes here exist
 * because a plugin sync answers for two registries at once — skills and MCP
 * servers can hold the same name — so every list is kind-qualified where a
 * single-registry sync's was flat.
 */

import type { SkillFile } from "@/domain/skill/types";
import type { SkippedAttachment } from "@/domain/skill/files";
import type { SyncExisting, SyncSkip } from "@/domain/sync/types";

/** One skill found under a plugin root, with its collected attachments. */
export interface RepoPluginSkill {
  /** Skill slug — the SKILL.md parent directory name. */
  name: string;
  path: string;
  content: string;
  files: SkillFile[];
}

/** One `org.opspresso.agent-studio/mcp/<server>.md` extension document. */
export interface RepoPluginDoc {
  server: string;
  path: string;
  content: string;
}

/** One plugin root as the repository holds it — raw files, not yet interpreted. */
export interface RepoPlugin {
  rootPath: string;
  /** Parsed by the sync, not the client — interpretation is the domain's. */
  manifestRaw: string;
  mcpJsonRaw?: string;
  skills: RepoPluginSkill[];
  mcpDocs: RepoPluginDoc[];
  skippedAttachments: SkippedAttachment[];
  /** `skills/` children whose directory name cannot be a registry name (paths). */
  badSkillDirs: string[];
}

export interface PluginsRepoSnapshot {
  repo: string;
  branch: string;
  commitSha: string;
  plugins: RepoPlugin[];
  /** Plugin roots refused for sitting inside another plugin (manifest paths). */
  nestedRoots: string[];
}

/**
 * Names a caller decided to act on, having seen a previous sync's report.
 * Kind-qualified throughout: the two registries may hold the same name, and a
 * flat list could not say which one the operator meant.
 */
export interface PluginSyncSelection {
  overwrite?: { skills?: string[]; mcpServers?: string[] };
  remove?: { skills?: string[]; mcpServers?: string[]; plugins?: string[] };
}

/** The four answers a sync gives about every name, for one kind. */
export interface PluginKindReport {
  created: string[];
  /** `differs` may include `"source"` — the takeover signal. */
  existing: SyncExisting[];
  overwritten: string[];
  orphaned: string[];
  removed: string[];
  skipped: SyncSkip[];
}

/** One plugin's slice of the report — also synthesized for a vanished plugin. */
export interface PluginSyncSection {
  plugin: string;
  version?: string;
  description?: string;
  skills: PluginKindReport;
  mcpServers: PluginKindReport;
}

export interface PluginSyncResult {
  repo: string;
  commitSha: string;
  plugins: PluginSyncSection[];
  /** Skips no plugin owns: unusable manifests, nested roots. */
  skipped: SyncSkip[];
  /** Plugin rows this repo put there that the snapshot no longer carries. */
  orphanedPlugins: string[];
  removedPlugins: string[];
}
