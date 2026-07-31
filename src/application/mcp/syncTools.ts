import type { ToolsRepoSnapshot } from "@/domain/mcp/toolsRepo";
import { ConflictError, ValidationError } from "@/application/errors";
import { firstHeadingOrLine, parseFrontmatter } from "@/shared/frontmatter";
import type { CreateMcpInput, McpUseCases } from "./mcpUseCases";

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
 * Why a document in the repo did not become a registry entry. Every one of
 * these is reported: a tool an operator wrote down and never got is exactly the
 * silent loss this repository's conventions exist to prevent.
 */
export type ToolSkipReason =
  /** A row already exists under that name. The stored row wins — see below. */
  | "exists"
  /** No `url` in the frontmatter, so there is nothing to register. */
  | "missing-url"
  /** The URL was refused — the SSRF guard, or a malformed address. */
  | "invalid-url"
  /** The directory name is not a usable registry entry name. */
  | "bad-name";

export interface SkippedTool {
  name: string;
  reason: ToolSkipReason;
  /** The guard's own message, for `invalid-url`. */
  detail?: string;
}

export interface ToolSyncResult {
  repo: string;
  commitSha: string;
  created: string[];
  skipped: SkippedTool[];
}

/**
 * Register every TOOL.md the snapshot holds that is not registered yet.
 *
 * **The database wins.** This is the opposite of the skills sync, and
 * deliberately so: a skill row is entirely reconstructible from its document,
 * while an MCP entry carries things the repository cannot hold — encrypted
 * headers, an OAuth block discovered from the server's own metadata, whatever
 * an admin corrected in the console. Upserting would destroy those on the next
 * sync, so an existing name is left untouched down to the byte and reported as
 * skipped. The repository declares what should exist; it does not own what
 * already does.
 *
 * Creation goes through the use case rather than the repository so a synced
 * entry faces exactly the checks a typed one does — the outbound URL guard, and
 * header encryption. A refusal skips that one document; the rest of the
 * snapshot still syncs.
 */
export async function syncToolsFromSnapshot(
  mcps: Pick<McpUseCases, "list" | "create">,
  snapshot: ToolsRepoSnapshot,
): Promise<ToolSyncResult> {
  const existing = new Set((await mcps.list()).map((server) => server.name));
  const created: string[] = [];
  const skipped: SkippedTool[] = [];

  for (const path of snapshot.skippedPaths) {
    skipped.push({ name: path, reason: "bad-name" });
  }

  for (const file of snapshot.files) {
    if (existing.has(file.name)) {
      skipped.push({ name: file.name, reason: "exists" });
      continue;
    }
    const { description, url, content } = parseToolDoc(file.content);
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
      // Never from the repository: a secret does not belong in git, so a server
      // that needs one is registered here and credentialed in the console.
      headers: {},
    };
    try {
      await mcps.create(input);
      created.push(file.name);
      // A name created now must not be created twice if the snapshot repeats it.
      existing.add(file.name);
    } catch (error) {
      if (error instanceof ConflictError) {
        // Someone registered it between the list and this write. The stored row
        // wins for the same reason it does above.
        skipped.push({ name: file.name, reason: "exists" });
        continue;
      }
      if (error instanceof ValidationError) {
        skipped.push({ name: file.name, reason: "invalid-url", detail: error.message });
        continue;
      }
      throw error;
    }
  }

  return { repo: snapshot.repo, commitSha: snapshot.commitSha, created, skipped };
}
