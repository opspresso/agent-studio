/**
 * Which directories of a plugins repository are what: plugin roots, each
 * root's skills, and each root's Agent Studio extension documents. Tree-shape
 * decisions live here so the GitHub client stays a raw fetcher — the same
 * split `domain/skill/files.ts` already draws for attachment selection.
 */

import type { SkillRoot, SkillTreeEntry } from "@/domain/skill/files";
import { STUDIO_PLUGIN_EXTENSION } from "./types";

export interface PluginRoot {
  /** Directory holding plugin.json, "" for the repository root. */
  rootPath: string;
  manifestPath: string;
}

/** Closest strict ancestor, with the repository root represented by an empty path. */
function ancestorRoot(path: string, roots: ReadonlySet<string>): string | undefined {
  for (let at = path.lastIndexOf("/"); at > 0; at = path.lastIndexOf("/", at - 1)) {
    const parent = path.slice(0, at);
    if (roots.has(parent)) return parent;
  }
  return path !== "" && roots.has("") ? "" : undefined;
}

/**
 * Every directory holding a `plugin.json`, anywhere in the tree — a repo may
 * be one plugin at its root or a monorepo of many. A root inside another root
 * is refused (`nested`): the spec has no plugin-in-plugin, and treating the
 * inner manifest as an outer plugin's file would make one repo mean two
 * things. Callers exclude a nested root's whole subtree with
 * {@link excludeSubtrees}.
 */
export function selectPluginRoots(entries: SkillTreeEntry[]): {
  roots: PluginRoot[];
  nested: PluginRoot[];
} {
  const all: PluginRoot[] = [];
  for (const entry of entries) {
    if (entry.type !== "blob") {
      continue;
    }
    if (entry.path !== "plugin.json" && !entry.path.endsWith("/plugin.json")) {
      continue;
    }
    const rootPath = entry.path.slice(0, Math.max(0, entry.path.length - "plugin.json".length - 1));
    all.push({ rootPath, manifestPath: entry.path });
  }

  const roots: PluginRoot[] = [];
  const nested: PluginRoot[] = [];
  const paths = new Set(all.map(root => root.rootPath));
  for (const candidate of all) {
    const inside = ancestorRoot(candidate.rootPath, paths) !== undefined;
    (inside ? nested : roots).push(candidate);
  }
  return { roots, nested };
}

/**
 * The tree split by which plugin owns each file, keyed by `rootPath`.
 *
 * The roots {@link selectPluginRoots} returns are disjoint — one inside
 * another is refused as `nested` — so a file belongs to at most one, and a
 * plugin's walk then costs its own files rather than the whole repository's.
 * Walking the entry's own parent directories rather than testing it against
 * every root is what keeps this linear in the tree: a monorepo of eighty
 * plugins over twelve thousand files had each of the four per-root passes
 * re-read the entire listing, which is a second of blocked event loop spent
 * deciding which file was whose.
 *
 * A file under no root is left out; nothing downstream has a plugin to
 * attribute it to.
 */
export function groupEntriesByRoot(
  entries: SkillTreeEntry[],
  roots: readonly PluginRoot[],
): Map<string, SkillTreeEntry[]> {
  const byRoot = new Map(roots.map((root) => [root.rootPath, [] as SkillTreeEntry[]]));
  // A repository that is one plugin at its root owns everything, and no parent
  // walk would ever reach the empty path.
  const wholeTree = byRoot.get("");
  if (wholeTree) {
    wholeTree.push(...entries);
    return byRoot;
  }
  const paths = new Set(byRoot.keys());
  for (const entry of entries) {
    const owner = ancestorRoot(entry.path, paths);
    if (owner !== undefined) byRoot.get(owner)!.push(entry);
  }
  return byRoot;
}

/** Drop everything under roots the walk has refused. */
export function excludeSubtrees(
  entries: SkillTreeEntry[],
  roots: readonly PluginRoot[],
): SkillTreeEntry[] {
  if (roots.length === 0) {
    return entries;
  }
  const paths = new Set(roots.map(root => root.rootPath));
  return entries.filter(entry => ancestorRoot(entry.path, paths) === undefined);
}

/**
 * The plugin's skills: immediate child directories of `<root>/skills/`
 * holding a SKILL.md — the spec's fixed discovery rule, deliberately narrower
 * than a match-anywhere walk. Whether a directory name may become a registry
 * entry name is the caller's question (the slug rule lives in `domain/naming.ts`); everything discovered is returned.
 */
export function selectPluginSkillRoots(
  root: PluginRoot,
  entries: SkillTreeEntry[],
): SkillRoot[] {
  const prefix = root.rootPath === "" ? "skills/" : `${root.rootPath}/skills/`;
  const roots: SkillRoot[] = [];
  for (const entry of entries) {
    if (entry.type !== "blob" || !entry.path.startsWith(prefix) || !entry.path.endsWith("/SKILL.md")) {
      continue;
    }
    const name = entry.path.slice(prefix.length, -"/SKILL.md".length);
    if (name.includes("/")) {
      // Not an immediate child; the spec does not discover it as a skill.
      continue;
    }
    roots.push({ name, rootPath: `${prefix}${name}`, skillMdPath: entry.path });
  }
  return roots;
}

/**
 * The server an extension document describes, or null for any other path.
 * Matches exactly `<root>/org.opspresso.agent-studio/mcp/<name>.md`.
 */
export function mcpDocServerName(path: string, root: PluginRoot): string | null {
  const prefix =
    root.rootPath === ""
      ? `${STUDIO_PLUGIN_EXTENSION}/mcp/`
      : `${root.rootPath}/${STUDIO_PLUGIN_EXTENSION}/mcp/`;
  if (!path.startsWith(prefix) || !path.endsWith(".md")) {
    return null;
  }
  const name = path.slice(prefix.length, -".md".length);
  return name !== "" && !name.includes("/") ? name : null;
}
