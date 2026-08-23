/**
 * The plugins repository as an uploaded archive — `git archive` or a `tar`
 * of a checkout — turned into the same snapshot the GitHub client builds.
 * For a deployment with no route to GitHub: the archive travels by hand, and
 * from here on the sync cannot tell the two apart.
 *
 * Provenance is the caller's to name (the repository the archive came from,
 * so rows keep the owner they had when GitHub was reachable), the branch is
 * fixed to {@link ARCHIVE_BRANCH} because the archive does not say, and the
 * commit is the archive's own digest — the one fact about it this side can
 * verify. It names the upload; whether anything changed is decided per row,
 * by content, the same way it is for a GitHub sync.
 */

import { createHash } from "node:crypto";
import { ARCHIVE_BRANCH, type PluginsRepoSnapshot } from "@/domain/plugin/sync";
import { SYMLINK_MODE } from "@/domain/skill/files";
import { decodeUtf8Text } from "@/shared/utf8Text";
import { readTarArchive, stripLeadingDirectory, TarArchiveError } from "@/infrastructure/archive/tar";
import { collectRepoPlugins, type PluginTreeFile } from "./snapshot";

export async function snapshotFromArchive(
  archive: Uint8Array,
  repo: string,
): Promise<PluginsRepoSnapshot> {
  // `tar czf` on macOS writes an AppleDouble `._<name>` beside every file
  // that carries extended attributes: a binary sidecar with the original's
  // extension, which the walker would select as a `.md` attachment and then
  // refuse as broken text. They are metadata, never content — dropped here,
  // not reported, so a checkout archived on a Mac syncs like one from Linux.
  // Dropped *before* the leading directory is decided: the sidecar of the
  // checkout directory itself is the archive's first entry, slash-less, and
  // would otherwise keep the directory on every path.
  const { files: content } = stripLeadingDirectory(
    readTarArchive(archive).filter((file) => !file.path.split("/").at(-1)?.startsWith("._")),
  );
  const tree: PluginTreeFile[] = content.map((file) => ({
    path: file.path,
    size: file.bytes.byteLength,
    // The mode git would report, so a symlink is refused — and reported — by
    // the same rule on both sources.
    ...(file.symlink ? { mode: SYMLINK_MODE } : {}),
    read: async () => {
      // A file the walker selected is by extension a text type, so bytes that
      // are not UTF-8 are a broken archive, not a binary to step over.
      const text = decodeUtf8Text(file.bytes);
      if (text === null) {
        throw new TarArchiveError(`archive entry "${file.path}" is not UTF-8 text`);
      }
      return text;
    },
  }));
  const { plugins, nestedRoots } = await collectRepoPlugins(tree);
  return {
    repo,
    branch: ARCHIVE_BRANCH,
    commitSha: createHash("sha256").update(archive).digest("hex"),
    plugins,
    nestedRoots,
  };
}

export { TarArchiveError };
