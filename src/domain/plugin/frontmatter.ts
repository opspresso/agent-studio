/**
 * The YAML-ish frontmatter block a synced markdown document opens with.
 *
 * The plugins sync reads one from two document kinds: a skill's `SKILL.md`
 * needs `name` and `description`, an MCP extension document needs
 * `description`. They must agree on what a document says — a second parser
 * would let the same file mean different things depending on which kind it
 * came in as — so the block is parsed here and each caller picks the fields
 * it wants out of `fields`.
 *
 * It sits beside the plugin types rather than in `shared` because the block is
 * part of the document format the domain already describes — `sync.ts` and
 * `files.ts` are its neighbours — and `shared` is the one layer they may not
 * import.
 *
 * Deliberately not a YAML implementation. Flat `key: value` lines plus folded
 * and literal scalars are what these documents use; anything else — including
 * the Agent Skills spec's nested `metadata:` map, which nothing here consumes
 * — is ignored rather than guessed at.
 */
export interface Frontmatter {
  /** Keys lowercased; values with surrounding quotes stripped. */
  fields: Record<string, string>;
  /** Everything after the closing delimiter, trimmed. */
  body: string;
}

export function parseFrontmatter(raw: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match?.[1]) {
    return { fields: {}, body: raw.trim() };
  }
  const fields: Record<string, string> = {};
  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec((lines[i] ?? "").trim());
    if (!kv?.[1] || kv[2] === undefined) {
      continue;
    }
    // A matched pair only: stripping each end independently would eat the
    // apostrophe off `'til dawn` or the lone quote off `"abc'`.
    let value = kv[2].replace(/^(["'])([\s\S]*)\1$/, "$2");
    // YAML folded/literal scalars (`key: >` or `key: |`): consume the
    // following indented lines and join them with spaces.
    if (value === ">" || value === "|" || value === ">-" || value === "|-") {
      const folded: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1] ?? "")) {
        folded.push((lines[i + 1] ?? "").trim());
        i += 1;
      }
      value = folded.join(" ");
    }
    fields[kv[1].toLowerCase()] = value;
  }
  return { fields, body: raw.slice(match[0].length).trim() };
}

/**
 * Fallback description for a document whose frontmatter declares none: its
 * first heading, or failing that its first non-empty line. Capped because both
 * consumers put the result somewhere a single line is expected — a skill's
 * listing entry, a tool's row in the model's server table.
 */
export function firstHeadingOrLine(text: string): string {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  // By character, never through one — see `savedFileName` for why this layer
  // spreads instead of importing `cutCodePoints`. What comes out of here is a
  // description the run puts in front of the model.
  return [...firstLine.replace(/^#+\s*/, "")].slice(0, 200).join("");
}
