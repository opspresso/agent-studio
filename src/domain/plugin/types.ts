import { isMcpSourceMappings, type McpSourceMapping } from "@/domain/mcp/sourceMapping";

/**
 * The Agent Plugins 1.0.0 formats (agent-plugins.org): the `plugin.json`
 * manifest and the `mcp.json` server map. Interpreted here, in one place —
 * the sync consumes these functions and never re-reads a raw file, so a
 * spec question ("is this name legal", "which transports do we run") has
 * exactly one answer.
 *
 * These are caps somebody else imposes on us — the spec's name rule, the
 * spec's transport set — which is why they live in `domain/` rather than
 * beside the sync that spends them.
 */

/**
 * The spec's plugin name rule. Deliberately NOT {@link isSlug}: a plugin name
 * may contain interior periods (`org.example.tools`), which no registry entry
 * name may. The two rules answer different questions — this one is "may this
 * manifest be used at all", the slug is "may this become a registry key".
 */
export const PLUGIN_NAME = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

/** True when `value` is a legal Agent Plugins plugin name. */
export function isPluginName(value: string): boolean {
  return value.length >= 1 && value.length <= 64 && PLUGIN_NAME.test(value);
}

/** What a refused plugin name should say, wherever it is refused. */
export const PLUGIN_NAME_RULE =
  "must be 1-64 lowercase letters, digits, '.' or '-', starting and ending alphanumeric, with no '--' or '..'";

/** The `$schema` values a 1.0.0 file must declare. */
export const PLUGIN_MANIFEST_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
export const MCP_JSON_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

export const STUDIO_PLUGIN_EXTENSION = "org.opspresso.agent-studio";

export interface PluginManifest {
  mcpSourceOutputs?: Record<string, McpSourceMapping[]>;
  name: string;
  version?: string;
  description?: string;
  author?: { name?: string; email?: string; url?: string };
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Parse a `plugin.json`. Fatal only where the spec says so: not JSON, not an
 * object, a missing or illegal `name`, a missing or wrong `$schema`. Unknown
 * top-level fields are non-fatal — the spec requires a client to tolerate
 * them — so they are simply not read.
 */
export function parsePluginManifest(
  raw: string,
): { ok: true; manifest: PluginManifest } | { ok: false; reason: string } {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "plugin.json is not valid JSON" };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ok: false, reason: "plugin.json must be a JSON object" };
  }
  const obj = data as Record<string, unknown>;
  if (obj.$schema !== PLUGIN_MANIFEST_SCHEMA) {
    return { ok: false, reason: `plugin.json $schema must be "${PLUGIN_MANIFEST_SCHEMA}"` };
  }
  if (typeof obj.name !== "string" || !isPluginName(obj.name)) {
    return { ok: false, reason: `plugin.json name ${PLUGIN_NAME_RULE}` };
  }
  const extensions = obj.extensions as Record<string, unknown> | undefined;
  const extension = extensions?.[STUDIO_PLUGIN_EXTENSION] as Record<string, unknown> | undefined;
  const mcpSourceOutputs = extension?.mcpSourceOutputs;
  if (mcpSourceOutputs !== undefined && (!mcpSourceOutputs || typeof mcpSourceOutputs !== "object" ||
    Array.isArray(mcpSourceOutputs) || Object.entries(mcpSourceOutputs).some(([name, mappings]) =>
      !isPluginName(name) || !isMcpSourceMappings(mappings)))) {
    return { ok: false, reason: "Invalid Agent Studio mcpSourceOutputs extension" };
  }
  const author =
    typeof obj.author === "object" && obj.author !== null && !Array.isArray(obj.author)
      ? {
          name: optionalString((obj.author as Record<string, unknown>).name),
          email: optionalString((obj.author as Record<string, unknown>).email),
          url: optionalString((obj.author as Record<string, unknown>).url),
        }
      : undefined;
  const keywords = Array.isArray(obj.keywords)
    ? obj.keywords.filter((keyword): keyword is string => typeof keyword === "string")
    : undefined;
  return {
    ok: true,
    manifest: {
      name: obj.name,
      ...(mcpSourceOutputs !== undefined ? { mcpSourceOutputs: mcpSourceOutputs as Record<string, McpSourceMapping[]> } : {}),
      version: optionalString(obj.version),
      description: optionalString(obj.description),
      ...(author ? { author } : {}),
      homepage: optionalString(obj.homepage),
      repository: optionalString(obj.repository),
      license: optionalString(obj.license),
      ...(keywords && keywords.length > 0 ? { keywords } : {}),
    },
  };
}

/**
 * Parse an `mcp.json` down to its named server entries. Fatal only for the
 * file itself — bad JSON, wrong `$schema`, no `mcpServers` object. Each
 * entry's own validity is a per-server question ({@link classifyMcpJsonServer})
 * so one bad server costs that server, not the file.
 */
export function parseMcpJson(
  raw: string,
): { ok: true; servers: Record<string, unknown> } | { ok: false; reason: string } {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "mcp.json is not valid JSON" };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ok: false, reason: "mcp.json must be a JSON object" };
  }
  const obj = data as Record<string, unknown>;
  if (obj.$schema !== MCP_JSON_SCHEMA) {
    return { ok: false, reason: `mcp.json $schema must be "${MCP_JSON_SCHEMA}"` };
  }
  const servers = obj.mcpServers;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    return { ok: false, reason: "mcp.json must carry an mcpServers object" };
  }
  return { ok: true, servers: servers as Record<string, unknown> };
}

export type McpServerClassification =
  /** A server this deployment can bind: streamable HTTP over a URL. */
  | { kind: "accepted"; url: string; declaredHeaderNames: string[] }
  /**
   * A transport this deployment never runs. `stdio` would mean executing an
   * operator-supplied command on the host — the exact capability the managed
   * runtime exists to withhold — and `sse` is the deprecated transport the
   * session owner never spoke. The spec expects a client to skip these.
   */
  | { kind: "unsupported-transport"; transport: string }
  /** An entry the schema does not allow at all. */
  | { kind: "invalid"; reason: string };

/**
 * THE decision of which mcp.json transports this deployment binds. The sync
 * acts on the classification and never inspects a `type` literal itself.
 */
export function classifyMcpJsonServer(entry: unknown): McpServerClassification {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return { kind: "invalid", reason: "server entry must be a JSON object" };
  }
  const obj = entry as Record<string, unknown>;
  if (typeof obj.type !== "string" || obj.type === "") {
    return { kind: "invalid", reason: "server entry must declare a type" };
  }
  if (obj.type !== "streamable-http") {
    return { kind: "unsupported-transport", transport: obj.type };
  }
  if (typeof obj.url !== "string" || obj.url === "") {
    return { kind: "invalid", reason: "a streamable-http server must declare a url" };
  }
  const headers =
    typeof obj.headers === "object" && obj.headers !== null && !Array.isArray(obj.headers)
      ? Object.keys(obj.headers)
      : [];
  return { kind: "accepted", url: obj.url, declaredHeaderNames: headers };
}

/**
 * Where every component a repository owns says it came from:
 * `github:<repo>#<plugin>`.
 *
 * Written by the plugins sync, read by {@link parsePluginSource} and by every
 * `startsWith` that asks "is this row this repository's?". Composition and
 * parsing share this owner so a delimiter change cannot make sync adopt rows it
 * does not own or make the console stop recognizing repo-owned rows.
 */
const SOURCE_SCHEME = "github:";

export function pluginSourcePrefix(repo: string): string {
  return `${SOURCE_SCHEME}${repo}#`;
}

/** The provenance string for one plugin of `repo`. */
export function pluginSource(repo: string, plugin: string): string {
  return pluginSourcePrefix(repo) + plugin;
}

/**
 * Read a component's provenance string back into its parts. Null for anything
 * else, including the retired single-repo form (`github:<repo>` with no `#`),
 * which names no plugin.
 */
export function parsePluginSource(
  source: string,
): { repo: string; plugin: string } | null {
  if (!source.startsWith(SOURCE_SCHEME)) {
    return null;
  }
  const hash = source.indexOf("#");
  if (hash < 0) {
    return null;
  }
  const repo = source.slice(SOURCE_SCHEME.length, hash);
  const plugin = source.slice(hash + 1);
  return repo !== "" && plugin !== "" ? { repo, plugin } : null;
}

/**
 * One installed plugin, as a row. Entirely a projection of the repository —
 * nothing on it is operator-authored — which is why the sync upserts it
 * unconditionally where every other registry row needs a named selection.
 */
export interface Plugin {
  /** The manifest's name — the spec pattern, so it may contain periods. */
  name: string;
  version?: string;
  description?: string;
  /** Repository the plugin was pulled from, e.g. "opspresso/agent-plugins". */
  repo: string;
  /** Git branch the sync read, or "archive" for an uploaded snapshot. */
  branch: string;
  /** Directory holding plugin.json, "" for a repo that is one plugin. */
  rootPath: string;
  /** Commit the last sync read. */
  commitSha: string;
  /** Conformant skill names the plugin declared at the last sync. */
  skills: string[];
  /** Accepted streamable-http server names at the last sync. */
  mcpServers: string[];
  syncedAt: string;
  createdAt: string;
  updatedAt: string;
}
