import type { ToolsRepoSnapshot } from "@/domain/mcp/toolsRepo";
import type {
  RepoSyncResult,
  SyncExisting,
  SyncSelection,
  SyncSkip,
} from "@/domain/sync/types";
import { ConflictError, ValidationError } from "@/application/errors";
import { firstHeadingOrLine, parseFrontmatter } from "@/shared/frontmatter";
import type { McpUseCases, UpdateMcpInput } from "./mcpUseCases";

export interface ParsedToolDoc {
  description: string;
  url?: string;
  content: string;
}

/**
 * Parse a TOOL.md document. The frontmatter names the server — `url` is what
 * makes the entry usable at all, `description` is the single line the model
 * sees in its connected-servers table — and the body is operator notes the
 * console shows and the model never does.
 */
export function parseToolDoc(raw: string): ParsedToolDoc {
  const { fields, body } = parseFrontmatter(raw);
  return {
    description: fields.description ?? firstHeadingOrLine(body),
    url: fields.url?.trim() || undefined,
    content: body,
  };
}

/** A document field the repository would replace on an entry that exists. */
export type ToolField = "url" | "description" | "content";

/**
 * Pull the tools repository into the registry.
 *
 * **A sync imports what is missing and reports everything else.** A name the
 * registry does not hold is created outright — that is the whole point of
 * writing a TOOL.md. A name it does hold is left exactly as it is and reported
 * with the fields the document would replace, because the stored version may be
 * a correction somebody made on purpose and nothing here can tell that apart
 * from a document that simply moved on. Only a caller naming it in `overwrite`
 * changes it.
 *
 * The same reasoning covers the other direction: an entry this sync created that
 * the repository no longer carries is reported as `orphaned`, never deleted. An
 * MCP entry holds credentials, and deleting one on the strength of a file
 * disappearing from a branch is not a decision this can make. Entries someone
 * registered by hand are not listed at all — they were never the repository's to
 * miss.
 *
 * **The document owns `url`, `description` and `content`; the registry owns
 * everything else.** When an overwrite does happen, only those three move.
 * Encrypted headers, a discovered OAuth block, a managed entry's provisioned
 * address and its image cannot live in git and are never touched. A field the
 * document does not carry leaves the stored one alone — an empty body says
 * nothing about the notes rather than asking for them to be erased.
 *
 * Two consequences of an overwrite are reported rather than assumed. Moving an
 * address discards the OAuth block read from the old one, which described a
 * server the entry no longer points at, so Discover has to be re-run. And a
 * managed entry's address was recorded by the provisioner that bound the port
 * rather than typed by anyone, so the document cannot move it; the rest of that
 * entry still overwrites and a `managed-url` skip says what was left out.
 *
 * Every write goes through the use case rather than the repository, so a synced
 * entry faces exactly the checks a typed one does — the name rule, the outbound
 * URL guard, header encryption. A refusal costs that one document; the rest of
 * the snapshot still syncs.
 */
export async function syncToolsFromSnapshot(
  mcps: Pick<McpUseCases, "list" | "create" | "update" | "remove">,
  snapshot: ToolsRepoSnapshot,
  selection: SyncSelection = {},
): Promise<RepoSyncResult> {
  const source = `github:${snapshot.repo}`;
  const overwrite = new Set(selection.overwrite ?? []);
  const remove = new Set(selection.remove ?? []);
  const stored = new Map((await mcps.list()).map((server) => [server.name, server]));

  const created: string[] = [];
  const existing: SyncExisting[] = [];
  const overwritten: string[] = [];
  const removed: string[] = [];
  const skipped: SyncSkip[] = [];

  for (const path of snapshot.skippedPaths) {
    skipped.push({ name: path, reason: "bad-name" });
  }

  for (const file of snapshot.files) {
    const { description, url, content } = parseToolDoc(file.content);
    const current = stored.get(file.name);

    if (!current) {
      if (!url) {
        skipped.push({ name: file.name, reason: "missing-url" });
        continue;
      }
      try {
        const server = await mcps.create({
          name: file.name,
          url,
          description,
          content: content || undefined,
          source,
          // Never from the repository: a secret does not belong in git, so a
          // server that needs one is registered here and credentialed in the
          // console.
          headers: {},
        });
        created.push(file.name);
        stored.set(file.name, server);
      } catch (error) {
        const reported = classify(file.name, error);
        if (!reported) {
          throw error;
        }
        skipped.push(reported);
      }
      continue;
    }

    // A managed entry's address is the basis for trusting it, and the use case
    // refuses to move one. Left out of the patch so the rest of the document can
    // still be applied, and reported either way — including when it is the only
    // thing that differs, or it would read as "already in step".
    const managed = current.runtime === "managed";
    const urlDiffers = Boolean(url) && url !== current.url;
    const patch: UpdateMcpInput = {
      ...(urlDiffers && !managed ? { url } : {}),
      ...(description && description !== current.description ? { description } : {}),
      ...(content && content !== current.content ? { content } : {}),
    };
    const differs = Object.keys(patch) as ToolField[];
    if (urlDiffers && managed) {
      skipped.push({ name: file.name, reason: "managed-url", detail: current.url });
    }

    if (!overwrite.has(file.name)) {
      existing.push({ name: file.name, differs });
      continue;
    }
    if (differs.length === 0) {
      // Asked for, but the document and the entry already agree. Writing anyway
      // would move `updatedAt` and make the registry look edited.
      existing.push({ name: file.name, differs });
      continue;
    }
    try {
      await mcps.update(file.name, patch);
      overwritten.push(file.name);
    } catch (error) {
      const reported = classify(file.name, error);
      if (!reported) {
        throw error;
      }
      skipped.push(reported);
    }
  }

  // Only what this sync put there. An entry someone registered by hand is not
  // the repository's to miss, and listing it would park a delete prompt next to
  // it on every sync forever.
  const inRepo = new Set(snapshot.files.map((file) => file.name));
  const orphaned: string[] = [];
  for (const server of stored.values()) {
    if (server.source !== source || inRepo.has(server.name)) {
      continue;
    }
    if (!remove.has(server.name)) {
      orphaned.push(server.name);
      continue;
    }
    await mcps.remove(server.name);
    removed.push(server.name);
  }

  return {
    repo: snapshot.repo,
    commitSha: snapshot.commitSha,
    created,
    existing,
    overwritten,
    orphaned,
    removed,
    skipped,
  };
}

/**
 * Turn a write failure into what the operator is told, or `null` when it is not
 * ours to explain — an unknown error is a bug and must reach the caller rather
 * than be filed as a skipped tool.
 */
function classify(name: string, error: unknown): SyncSkip | null {
  if (error instanceof ConflictError) {
    // The name was taken between reading the registry and this write. Nothing
    // is wrong with the document — the next sync finds the row and updates it,
    // which is the ordinary path — so it is reported as the race it is rather
    // than as a fault in the URL.
    return { name, reason: "conflict" };
  }
  if (error instanceof ValidationError) {
    return { name, reason: "invalid-url", detail: error.message };
  }
  return null;
}
