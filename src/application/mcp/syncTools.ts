import type { ToolsRepoSnapshot } from "@/domain/mcp/toolsRepo";
import { ConflictError, ValidationError } from "@/application/errors";
import { firstHeadingOrLine, parseFrontmatter } from "@/shared/frontmatter";
import type { CreateMcpInput, McpUseCases, UpdateMcpInput } from "./mcpUseCases";

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

/**
 * Why a document in the repo did not become — or update — a registry entry.
 * Every one of these is reported: a tool an operator wrote down and never got is
 * exactly the silent loss this repository's conventions exist to prevent.
 */
export type ToolSkipReason =
  /** No `url` anywhere: not in the frontmatter, and no stored row to keep one. */
  | "missing-url"
  /** The URL was refused — the SSRF guard, or a malformed address. */
  | "invalid-url"
  /** The directory name is not a usable registry entry name. */
  | "bad-name"
  /**
   * The document's `url` was left out: a managed entry's address is recorded by
   * the provisioner that bound the port, never typed, so the repository cannot
   * own it. The entry's other fields still synced.
   */
  | "managed-url"
  /** The name was taken between reading the registry and writing. */
  | "conflict";

export interface SkippedTool {
  name: string;
  reason: ToolSkipReason;
  /** The guard's own message, for `invalid-url`. */
  detail?: string;
}

/** A document field the repository replaced on an entry that already existed. */
export type ToolField = "url" | "description" | "content";

export interface UpdatedTool {
  name: string;
  fields: ToolField[];
  /**
   * The entry's address changed, so the OAuth block discovered from the old
   * address was dropped with it — it named a server this entry no longer points
   * at. An admin has to re-run Discover.
   */
  authDropped?: boolean;
}

export interface ToolSyncResult {
  repo: string;
  commitSha: string;
  created: string[];
  updated: UpdatedTool[];
  /** In the repo, already identical in the registry. */
  unchanged: string[];
  skipped: SkippedTool[];
}

/**
 * Register every TOOL.md the snapshot holds, and bring the ones already
 * registered back in line with their document.
 *
 * **The repository owns the document; the registry owns everything else.** Those
 * are different sets of fields and the split is the whole design. `url`,
 * `description` and `content` are what a TOOL.md says, so the repository is
 * authoritative for them and a sync replaces what is stored. Encrypted headers,
 * a discovered OAuth block, a managed entry's provisioned address and its image
 * — none of those can live in git, and none are touched. An entry that used to
 * be skipped outright because it existed now tracks its document without ever
 * losing the credentials that make it usable.
 *
 * A field the document does not carry leaves the stored one alone: an empty
 * body is a document that says nothing about the notes, not one that asks for
 * them to be erased. Only a `url` is required, and only for an entry that has no
 * stored one to keep.
 *
 * Two consequences are reported rather than assumed. Changing an address
 * discards the OAuth block read from the old one — it described a server this
 * entry no longer points at — so `authDropped` says Discover has to be re-run.
 * And a managed entry's address was recorded by the provisioner that bound the
 * port rather than typed by anyone, so the document cannot move it; the rest of
 * that entry still syncs and a `managed-url` skip says what was left out.
 *
 * Every write goes through the use case rather than the repository, so a synced
 * entry faces exactly the checks a typed one does — the outbound URL guard, and
 * header encryption. A refusal costs that one document; the rest still syncs.
 */
export async function syncToolsFromSnapshot(
  mcps: Pick<McpUseCases, "list" | "create" | "update">,
  snapshot: ToolsRepoSnapshot,
): Promise<ToolSyncResult> {
  const stored = new Map((await mcps.list()).map((server) => [server.name, server]));
  const created: string[] = [];
  const updated: UpdatedTool[] = [];
  const unchanged: string[] = [];
  const skipped: SkippedTool[] = [];

  for (const path of snapshot.skippedPaths) {
    skipped.push({ name: path, reason: "bad-name" });
  }

  for (const file of snapshot.files) {
    const { description, url, content } = parseToolDoc(file.content);
    const existing = stored.get(file.name);

    if (!existing) {
      if (!url) {
        skipped.push({ name: file.name, reason: "missing-url" });
        continue;
      }
      const input: CreateMcpInput = {
        name: file.name,
        url,
        description,
        content: content || undefined,
        source: `github:${snapshot.repo}`,
        // Never from the repository: a secret does not belong in git, so a
        // server that needs one is registered here and credentialed in the
        // console.
        headers: {},
      };
      try {
        const server = await mcps.create(input);
        created.push(file.name);
        // A name created now must not be created twice if the snapshot repeats
        // it — and a repeat is an update from here, like any other.
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
    // refuses to move one. Leaving it out of the patch keeps the rest of the
    // document syncing instead of failing the whole entry on a field the
    // repository was never entitled to — reported either way, including when it
    // is the only thing the document changed, or it would vanish into
    // "unchanged".
    const managed = existing.runtime === "managed";
    const urlChanged = Boolean(url) && url !== existing.url;
    if (urlChanged && managed) {
      skipped.push({ name: file.name, reason: "managed-url", detail: existing.url });
    }
    const patch: UpdateMcpInput = {
      ...(urlChanged && !managed ? { url } : {}),
      ...(description && description !== existing.description ? { description } : {}),
      ...(content && content !== existing.content ? { content } : {}),
    };
    const fields = Object.keys(patch) as ToolField[];
    if (fields.length === 0) {
      unchanged.push(file.name);
      continue;
    }
    try {
      await mcps.update(file.name, patch);
      updated.push({
        name: file.name,
        fields,
        ...(patch.url && existing.auth ? { authDropped: true } : {}),
      });
    } catch (error) {
      const reported = classify(file.name, error);
      if (!reported) {
        throw error;
      }
      skipped.push(reported);
    }
  }

  return { repo: snapshot.repo, commitSha: snapshot.commitSha, created, updated, unchanged, skipped };
}

/**
 * Turn a write failure into what the operator is told, or `null` when it is not
 * ours to explain — an unknown error is a bug and must reach the caller rather
 * than be filed as a skipped tool.
 */
function classify(name: string, error: unknown): SkippedTool | null {
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
