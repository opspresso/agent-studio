/**
 * Which directories of a plugins repository are what: plugin roots, each
 * root's skills, and each root's AgentDure extension documents. Tree-shape
 * decisions live here so the GitHub client stays a raw fetcher — the same
 * split `domain/skill/files.ts` already draws for attachment selection.
 */

import type { SkillRoot, SkillTreeEntry } from "@/domain/skill/files";

/**
 * This org's reverse-domain client-extension namespace, per the spec's
 * convention. `mcp/<server>.md` inside it carries what the closed mcp.json
 * schema has no field for: the server's model-facing description and the
 * operator notes. Other clients ignore the directory entirely.
 */
export const AGENTDURE_EXTENSION_DIR = "org.opspresso.agentdure";

export interface PluginRoot {
  /** Directory holding plugin.json, "" for the repository root. */
  rootPath: string;
  manifestPath: string;
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
  for (const candidate of all) {
    const inside = all.some(
      (other) =>
        other !== candidate &&
        (other.rootPath === "" || candidate.rootPath.startsWith(`${other.rootPath}/`)),
    );
    (inside ? nested : roots).push(candidate);
  }
  return { roots, nested };
}

/** Drop everything under the given roots — used to blind a walk to refused subtrees. */
export function excludeSubtrees(
  entries: SkillTreeEntry[],
  roots: readonly PluginRoot[],
): SkillTreeEntry[] {
  if (roots.length === 0) {
    return entries;
  }
  return entries.filter(
    (entry) =>
      !roots.some(
        (root) => root.rootPath === "" || entry.path.startsWith(`${root.rootPath}/`),
      ),
  );
}

/**
 * The plugin's skills: immediate child directories of `<root>/skills/`
 * holding a SKILL.md — the spec's fixed discovery rule, deliberately narrower
 * than a match-anywhere walk. Whether a directory name may become a registry
 * entry name is the caller's question (the slug rule lives in `shared/`,
 * which the domain does not import); everything discovered is returned.
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
 * Matches exactly `<root>/org.opspresso.agentdure/mcp/<name>.md`.
 */
export function mcpDocServerName(path: string, root: PluginRoot): string | null {
  const prefix =
    root.rootPath === ""
      ? `${AGENTDURE_EXTENSION_DIR}/mcp/`
      : `${root.rootPath}/${AGENTDURE_EXTENSION_DIR}/mcp/`;
  if (!path.startsWith(prefix) || !path.endsWith(".md")) {
    return null;
  }
  const name = path.slice(prefix.length, -".md".length);
  return name !== "" && !name.includes("/") ? name : null;
}
