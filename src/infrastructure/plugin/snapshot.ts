/**
 * One file listing in, the plugins a sync needs out. Finds every plugin root
 * (`plugin.json` anywhere in the tree) and collects per root what the spec
 * fixes in place: `skills/<name>/SKILL.md` with attachments, `mcp.json`, and
 * this org's extension documents. Raw reads only — plugin.json and mcp.json
 * come back as strings, because interpreting them is the domain's job
 * (`@/domain/plugin/types`), not this walker's.
 *
 * Shared by the two ways a repository reaches this deployment — GitHub's
 * tree API and an uploaded archive — so which directories mean what is
 * decided once, whatever the bytes came over. Each source only says how a
 * file is listed and how it is read.
 */

import type { SkillFile } from "@/domain/skill/types";
import { selectSkillAttachments, type SkillTreeEntry } from "@/domain/skill/files";
import { isSlug } from "@/domain/naming";
import {
  excludeSubtrees,
  groupEntriesByRoot,
  mcpDocServerName,
  selectPluginRoots,
  selectPluginSkillRoots,
} from "@/domain/plugin/files";
import type { RepoPlugin, RepoPluginDoc, RepoPluginSkill } from "@/domain/plugin/sync";
import { mapWithLimit } from "@/shared/mapWithLimit";

/** Selected repository blobs read concurrently during one plugin walk. */
export const MAX_CONCURRENT_PLUGIN_READS = 8;

/** One regular file of the repository tree, read on demand. */
export interface PluginTreeFile {
  path: string;
  /** Bytes, as the source reports them; the attachment caps are checked against this. */
  size: number;
  /** git's mode string when the source knows it — `120000` marks a symlink. */
  mode?: string;
  read(): Promise<string>;
}

export async function collectRepoPlugins(
  files: PluginTreeFile[],
): Promise<{ plugins: RepoPlugin[]; nestedRoots: string[] }> {
  const byPath = new Map(files.map((file) => [file.path, file]));
  // The tree walker asks for a `sha` only to hand it back as the handle a
  // blob is read by; the path is that handle here.
  const tree: SkillTreeEntry[] = files.map((file) => ({
    path: file.path,
    type: "blob",
    sha: file.path,
    ...(file.mode !== undefined ? { mode: file.mode } : {}),
    size: file.size,
  }));
  const read = (path: string): Promise<string> => {
    const file = byPath.get(path);
    if (!file) {
      throw new Error(`plugins tree lists no file at ${path}`);
    }
    return file.read();
  };

  const { roots, nested } = selectPluginRoots(tree);
  // A nested root is refused whole: none of its files may double as an outer
  // plugin's skill or attachment, or one repo would mean two things.
  const entries = excludeSubtrees(tree, nested);

  // Each root's own files, decided in one pass over the tree: every walk below
  // is per plugin, and running each of them over the whole listing is what made
  // a monorepo's sync cost the square of its size.
  const entriesByRoot = groupEntriesByRoot(entries, roots);

  const plugins: RepoPlugin[] = [];
  for (const root of roots) {
    const owned = entriesByRoot.get(root.rootPath) ?? [];
    const ownedByPath = new Map(owned.map((entry) => [entry.path, entry]));
    const manifestEntry = ownedByPath.get(root.manifestPath);
    if (!manifestEntry) {
      continue;
    }

    const mcpJsonPath = root.rootPath === "" ? "mcp.json" : `${root.rootPath}/mcp.json`;
    const mcpJsonEntry = ownedByPath.get(mcpJsonPath);

    // A directory name that is not a slug cannot become a registry entry name.
    // Reported rather than dropped: a document nobody ever sees is the failure
    // the plugin convention exists to prevent.
    const discovered = selectPluginSkillRoots(root, owned);
    const skillRoots = discovered.filter((candidate) => isSlug(candidate.name));
    const badNames = discovered
      .filter((candidate) => !isSlug(candidate.name))
      .map((candidate) => candidate.skillMdPath);
    const { selected, skipped } = selectSkillAttachments(owned, skillRoots);
    const docEntries = owned.filter((entry) => mcpDocServerName(entry.path, root) !== null);

    // One plugin's selected files share a worker queue. A serial walk multiplied
    // every network round trip by the file count; an unbounded `Promise.all`
    // turned a large repository into the same number of simultaneous GitHub
    // blob requests.
    const selectedPaths = [
      manifestEntry.path,
      ...(mcpJsonEntry ? [mcpJsonEntry.path] : []),
      ...selected.map((attachment) => attachment.sha),
      ...skillRoots.flatMap((skillRoot) => {
        const skillMd = ownedByPath.get(skillRoot.skillMdPath);
        return skillMd ? [skillMd.path] : [];
      }),
      ...docEntries.map((entry) => entry.path),
    ];
    const loaded = new Map(
      await mapWithLimit(selectedPaths, MAX_CONCURRENT_PLUGIN_READS, async (path) => [
        path,
        await read(path),
      ] as const),
    );
    const manifestRaw = loaded.get(manifestEntry.path)!;
    const mcpJsonRaw = mcpJsonEntry ? loaded.get(mcpJsonEntry.path) : undefined;
    const attachments = selected.map((attachment) => ({
      attachment,
      content: loaded.get(attachment.sha)!,
    }));
    const skillMds = skillRoots.map((skillRoot) => {
      const skillMd = ownedByPath.get(skillRoot.skillMdPath);
      return skillMd ? { skillRoot, content: loaded.get(skillMd.path)! } : null;
    });
    const docs = docEntries.map((entry) => ({
      server: mcpDocServerName(entry.path, root) ?? "",
      path: entry.path,
      content: loaded.get(entry.path)!,
    }));

    const attachmentsByName = new Map<string, SkillFile[]>();
    for (const { attachment, content } of attachments) {
      const list = attachmentsByName.get(attachment.name) ?? [];
      list.push({ path: attachment.relPath, content });
      attachmentsByName.set(attachment.name, list);
    }

    const skills: RepoPluginSkill[] = skillMds
      .filter((loaded): loaded is NonNullable<typeof loaded> => loaded !== null)
      .map(({ skillRoot, content }) => ({
        name: skillRoot.name,
        path: skillRoot.skillMdPath,
        content,
        files: attachmentsByName.get(skillRoot.name) ?? [],
      }));

    const mcpDocs: RepoPluginDoc[] = docs;

    plugins.push({
      rootPath: root.rootPath,
      manifestRaw,
      mcpJsonRaw,
      skills,
      mcpDocs,
      skippedAttachments: skipped,
      badSkillDirs: badNames,
    });
  }

  return { plugins, nestedRoots: nested.map((root) => root.manifestPath) };
}
