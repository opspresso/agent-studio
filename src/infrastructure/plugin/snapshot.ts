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

    // One plugin's files read together — a serial walk multiplied every
    // network round trip by the file count, which is what let a slow GitHub
    // read push the whole sync past the proxy's idle timeout.
    const [manifestRaw, mcpJsonRaw, attachments, skillMds, docs] = await Promise.all([
      read(manifestEntry.path),
      mcpJsonEntry ? read(mcpJsonEntry.path) : Promise.resolve(undefined),
      Promise.all(
        selected.map(async (attachment) => ({
          attachment,
          content: await read(attachment.sha),
        })),
      ),
      Promise.all(
        skillRoots.map(async (skillRoot) => {
          const skillMd = ownedByPath.get(skillRoot.skillMdPath);
          return skillMd ? { skillRoot, content: await read(skillMd.path) } : null;
        }),
      ),
      Promise.all(
        docEntries.map(async (entry) => ({
          server: mcpDocServerName(entry.path, root) ?? "",
          path: entry.path,
          content: await read(entry.path),
        })),
      ),
    ]);

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
