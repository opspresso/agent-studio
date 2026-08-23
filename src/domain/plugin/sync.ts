/**
 * What one pull of the plugins repository carries, and what a sync of it
 * reports. The skip vocabulary (`SyncSkip`) lives in `domain/sync/types.ts`;
 * the shapes here exist because a plugin sync answers for two registries at
 * once — skills and MCP servers can hold the same name — so every list is
 * kind-qualified.
 */

import type { SkillFile } from "@/domain/skill/types";
import type { SkippedAttachment } from "@/domain/skill/files";
import type { SyncSkip } from "@/domain/sync/types";

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
 * Deletions a caller decided on, having seen a previous sync's report — the
 * one act the sync does not perform on its own, because an MCP entry holds
 * credentials and a file disappearing from a branch is not reason enough to
 * destroy them. Kind-qualified: the two registries may hold the same name.
 */
export interface PluginSyncSelection {
  remove?: { skills?: string[]; mcpServers?: string[]; plugins?: string[] };
}

/**
 * One entry the sync rewrote, and which fields moved. `fields` may name
 * `source` (an adoption — the entry changed hands), so a console edit that
 * was replaced and an ordinary document refresh read differently.
 */
export interface SyncWrite {
  name: string;
  fields: string[];
}

/**
 * One entry the repository no longer declares, with the version bindings that
 * would dangle if it were deleted — the blast radius the delete checkbox
 * needs, as `project/version` labels. Empty when nothing binds it.
 */
export interface SyncOrphan {
  name: string;
  boundTo: string[];
}

/** The answers a sync gives about every name, for one kind. */
export interface PluginKindReport {
  created: string[];
  /** Applied automatically — the repository owns what it declared. */
  overwritten: SyncWrite[];
  /** In both, already in agreement; nothing was written. */
  unchanged: string[];
  orphaned: SyncOrphan[];
  removed: string[];
  skipped: SyncSkip[];
}

/** Which versions bind the names a sync is about to offer for deletion. */
export interface OrphanBindings {
  skills: Record<string, string[]>;
  mcpServers: Record<string, string[]>;
}

/**
 * Whether a report carries a fenced write failure — the one outcome a
 * commit-unchanged tick must not skip past, because only a re-run repairs it.
 */
export function reportHasFailures(report: PluginSyncResult): boolean {
  const failed = (skips: SyncSkip[]) => skips.some((skip) => skip.reason === "write-failed");
  return (
    failed(report.skipped) ||
    report.plugins.some(
      (section) => failed(section.skills.skipped) || failed(section.mcpServers.skipped),
    )
  );
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

/**
 * The provenance an uploaded archive's rows carry. Every component a sync
 * writes says which repository owns it, and the next sync — whichever way it
 * arrives — adopts what that name claims and orphans what it no longer
 * declares. An archive does not say where it came from, so the deployment's
 * configured repository is the default: rows synced from GitHub while it was
 * reachable keep their owner when the same repository later arrives by hand.
 * With no repository configured, the one fixed name keeps each upload
 * continuing the last rather than starting a registry of its own.
 */
export const ARCHIVE_SYNC_REPO = "archive";

/** What a snapshot's `branch` says when the source was an uploaded archive. */
export const ARCHIVE_BRANCH = "archive";

/**
 * Whether a sync's commit names an uploaded archive rather than a git commit:
 * the archive's sha256 is 64 hex characters where git's are 40. A report
 * carries no branch, so this is the one way to tell after the fact — and the
 * one place that says so.
 */
export function isArchiveSync(commitSha: string): boolean {
  return /^[0-9a-f]{64}$/.test(commitSha);
}

export function archiveSyncRepo(configuredRepo: string | undefined): string {
  return configuredRepo ?? ARCHIVE_SYNC_REPO;
}
