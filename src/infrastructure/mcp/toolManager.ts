/**
 * MCP tool manager. Builds a run's tool set over {@link McpSession}, which owns
 * the protocol. Behaviours:
 *   - tool-name collision aliasing (`name_1`, `name_2`) with a reverse mapping,
 *   - builtin reserved names are seeded so only MCP tools get suffixed,
 *   - results capped at 100,000 chars; multi-block results JSON-stringified,
 *   - failures (transport, JSON-RPC, and the server's own `isError`) come back as
 *     `Error: …` text, never thrown: the model reads them as a tool result and
 *     the trace recorder reads the prefix as a failed span,
 *   - a result the server marks `input_required` is one of those failures, and
 *     says so as itself: this client does not answer multi round-trip requests,
 *   - a server that cannot be reached loses only its own tools, and the reason
 *     is reported through {@link ToolManager.warnings} so the run can surface it
 *     — including the two readings that are not "unreachable": a 401 asks the
 *     project to reconnect, and a server this client cannot speak to asks for a
 *     fix on one side or the other,
 *   - discovery is served from {@link ../discoveryCache the discovery cache} when
 *     it is warm, which also leaves the session to connect lazily on its first
 *     tool call — a turn that calls nothing then makes no MCP request at all,
 *     and a turn that calls several at once still connects exactly once
 *     ({@link ./session McpSession} serializes it).
 */

import type { McpServerConfig } from "@/domain/mcp/toolSession";
import type { ChannelToolDef } from "@/domain/llm/channel";
import type { ImageBytes } from "@/domain/llm/imageChannel";
import { base64ByteLength, MAX_ATTACHMENT_BYTES } from "@/domain/llm/imageLimits";
import type { McpToolResult } from "@/domain/llm/types";
import {
  type DiscoveryFailure,
  getCachedDiscovery,
  setCachedFailure,
  setCachedTools,
} from "./discoveryCache";
import { isUnauthorized, McpSession, unusableServerReason, type McpTool } from "./session";
import { log } from "@/shared/logger";
import { cutCodePoints, decodeUtf8Text } from "@/shared/utf8Text";

const MAX_TOOL_RESULT_LENGTH = 100_000;

/**
 * How large a file a tool result may carry.
 *
 * Our cap, beside the mechanism that spends it. The real ceiling is above it:
 * `MAX_MCP_RESPONSE_BYTES` bounds the whole JSON-RPC response and base64 inflates
 * by 4/3, so a server that wants to hand over something bigger has to say so
 * itself rather than have the transport cut it — a truncated envelope arrives as
 * a parse failure, which says nothing about the document being large.
 */
const MAX_TOOL_FILE_BYTES = 10_500_000;

/** Files one result may carry. A tool returning a directory is not this. */
const MAX_TOOL_FILES_PER_RESULT = 4;

export type { McpServerConfig };

export class ToolManager {
  private readonly servers: McpServerConfig[];
  private readonly reservedToolNames: Set<string>;
  private readonly sessionByToolName = new Map<string, McpSession>();
  private readonly originalNameByAlias = new Map<string, string>();
  /**
   * The catalogue entry behind each alias, kept for the call rather than the
   * offer: the SEP-2243 parameter mirroring reads the tool's `inputSchema`, and
   * on a warm discovery cache no `tools/list` was sent this run for the client
   * to read one from. See {@link McpSession.callTool}.
   */
  private readonly toolByAlias = new Map<string, McpTool>();
  /**
   * Which server an alias came from, for the failure messages. A run may bind
   * several servers, and "HTTP 500" without one names nothing an operator can
   * go and look at.
   */
  private readonly serverNameByAlias = new Map<string, string>();
  /** One entry per session opened, for teardown. */
  private readonly sessions: McpSession[] = [];
  private _tools: ChannelToolDef[] = [];
  private _toolNamesByServer = new Map<string, string[]>();
  private readonly _warnings: string[] = [];
  private readonly _unauthorizedServers: string[] = [];

  constructor(
    servers: McpServerConfig[],
    reservedToolNames?: Iterable<string>,
    private readonly signal?: AbortSignal,
  ) {
    this.servers = servers;
    this.reservedToolNames = new Set(reservedToolNames ?? []);
  }

  get tools(): ChannelToolDef[] {
    return this._tools;
  }

  /** Aliased tool names grouped by server name; unreachable servers are absent. */
  get toolNamesByServer(): Map<string, string[]> {
    return this._toolNamesByServer;
  }

  /**
   * Why a configured server contributed no tools. A run reports these to the
   * user: without them an unreachable server is indistinguishable from a model
   * that chose not to call anything.
   */
  get warnings(): readonly string[] {
    return this._warnings;
  }

  /**
   * Servers that answered 401. Separate from {@link warnings} because it asks
   * for something specific — the project must re-authorize — while every other
   * discovery failure asks the operator to look at the server.
   */
  get unauthorizedServers(): readonly string[] {
    return this._unauthorizedServers;
  }

  aliasFor(serverName: string, toolName: string): string | undefined {
    // Walk this server's own aliases and read each one back through the
    // reverse map: the offered name is what the run calls, the original is
    // what the caller asked about, and only the pair says which is which.
    for (const alias of this._toolNamesByServer.get(serverName) ?? []) {
      if (this.originalNameByAlias.get(alias) === toolName) {
        return alias;
      }
    }
    return undefined;
  }

  /**
   * Connect to every server and build the tool set. Discovery runs in parallel
   * — servers are independent, and a single unreachable one would otherwise add
   * its full 120s timeout to the time-to-first-token. Alias allocation stays
   * sequential in the configured server order so names are deterministic.
   */
  async init(): Promise<void> {
    this.signal?.throwIfAborted();
    if (this.servers.length === 0) {
      return;
    }
    const discovered = await Promise.all(
      this.servers.map(async (server) => {
        // The identity headers key the cache below; the context headers only
        // travel. Merged for the wire, kept apart for the lookup.
        const session = new McpSession(
          server.url,
          { ...server.headers, ...server.contextHeaders },
          this.signal,
          server.loopback,
        );
        // Registered before the first request: a session that connects and then
        // fails — or one abandoned when the run aborts mid-discovery — must
        // still be reachable by `close()`, or it is leaked server-side.
        this.sessions.push(session);
        const cached = getCachedDiscovery(server.url, server.headers);
        if (cached?.kind === "tools") {
          // The session stays unconnected; it connects on its first actual tool
          // call, so a run that calls nothing makes no request at all.
          return { server, session, tools: cached.tools };
        }
        if (cached?.kind === "failure") {
          // Replayed rather than re-attempted: without this a server that is
          // down re-pays a failing connect before the first token of every
          // message. The reason is the live one, so the run explains itself the
          // same way it did when the failure actually happened.
          this.recordFailure(server.name, cached);
          return null;
        }
        try {
          const { tools, ttlMs } = await session.listTools();
          setCachedTools(server.url, server.headers, tools, ttlMs);
          return { server, session, tools };
        } catch (error) {
          // The caller leaving mid-discovery is not the server failing, and it
          // must not be remembered as one: the failure cache is keyed per
          // `url + headers`, so a reload during a slow first token would hand
          // every run of that project a "server unavailable" replay for the
          // failure window, against a server that never answered wrongly. The
          // rethrow lands on the `throwIfAborted` below, which is what an
          // aborted init was always going to reach.
          if (this.signal?.aborted) {
            throw error;
          }
          // A single broken MCP must not abort the whole tool set — but it must
          // not vanish either: without this the tools are simply absent and the
          // run looks like a model that ignored them.
          const reason = error instanceof Error ? error.message : String(error);
          const unusable = unusableServerReason(error);
          log.warn(
            "mcp",
            `discovery failed for '${server.name}' (${server.url}); its tools are unavailable this run:`,
            unusable ?? reason,
          );
          const failure: DiscoveryFailure = {
            reason,
            unauthorized: isUnauthorized(error),
            ...(unusable ? { unusable } : {}),
          };
          setCachedFailure(server.url, server.headers, failure);
          this.recordFailure(server.name, failure);
          return null;
        }
      }),
    );
    this.signal?.throwIfAborted();

    const usedNames = new Set<string>(this.reservedToolNames);
    const aliasIndexByName = new Map<string, number>();
    const tools: ChannelToolDef[] = [];
    for (const entry of discovered) {
      if (!entry) {
        continue;
      }
      if (entry.tools.length === 0) {
        const described = entry.session.describedAs;
        // The one outcome that would otherwise explain nothing: the connection
        // succeeded, `tools/list` answered, and the answer was empty. Left
        // silent, the server vanishes from the run — no error, no tools, and no
        // row in the system prompt's server table — with nothing to tell an
        // operator apart a server that offers nothing from one this app
        // dropped. Say it, so they go and look at the server.
        //
        // A server that answered but never declared it has tools is the one
        // case where the emptiness has a cause worth naming: the protocol says
        // a server with tools declares the capability, so this client never
        // asked for the list. `undefined` rather than `false` is a session the
        // discovery cache served without connecting — nothing was asked, so
        // nothing may be claimed.
        const undeclared =
          entry.session.declaresTools === false
            ? " It did not declare the 'tools' capability, so its catalogue was never requested."
            : "";
        this._warnings.push(
          `MCP server '${entry.server.name}' is connected but offers no tools; a run has nothing to call on it.` +
            undeclared +
            (described ? ` It identified itself as: ${described}.` : ""),
        );
      }
      const offered = this.selectOffered(entry.server, entry.tools);
      const aliases: string[] = [];
      for (const tool of offered) {
        const invalid = invalidToolReason(tool);
        if (invalid) {
          this._warnings.push(
            `MCP server '${entry.server.name}' offered invalid tool '${String(tool.name)}'; it was not offered: ${invalid}.`,
          );
          continue;
        }
        const alias = allocateToolName(providerToolName(tool.name), usedNames, aliasIndexByName);
        tools.push({
          type: "function",
          function: {
            name: alias,
            description: tool.description,
            parameters: { type: "object", properties: {}, ...(tool.inputSchema ?? {}) },
          },
        });
        this.sessionByToolName.set(alias, entry.session);
        this.originalNameByAlias.set(alias, tool.name);
        this.toolByAlias.set(alias, tool);
        this.serverNameByAlias.set(alias, entry.server.name);
        aliases.push(alias);
      }
      this._toolNamesByServer.set(entry.server.name, aliases);
    }
    this._tools = tools;
  }

  /**
   * One place turns a discovery failure into what the run reports, so a cached
   * failure and a live one are indistinguishable to the caller. A 401 is kept
   * apart: naming it "unreachable" would send the operator to check a server
   * that is working fine and answering exactly as it should.
   */
  private recordFailure(serverName: string, failure: DiscoveryFailure): void {
    if (failure.unauthorized) {
      this.recordUnauthorized(serverName);
      this._warnings.push(
        `MCP server '${serverName}' rejected this project's credentials; it needs to be reconnected before its tools are available.`,
      );
      return;
    }
    // A server that answered, in a way this client cannot use: a revision only
    // newer clients speak, a reply that breaks the schema, a catalogue that
    // never finishes paging. It is neither down nor misconfigured, so
    // "unreachable" would send an operator to look at a host that is working —
    // what these ask for is a fix on one side or the other. A server still on a
    // 2025-era revision is *not* one of them: the probe falls back to the
    // handshake and it runs like any other.
    if (failure.unusable) {
      this._warnings.push(
        `MCP server '${serverName}' cannot be used by this client: ${failure.unusable} Its tools are unavailable this run.`,
      );
      return;
    }
    this._warnings.push(
      `MCP server '${serverName}' is unreachable (${failure.reason}); its tools are unavailable this run.`,
    );
  }

  /**
   * Note that a server rejected this project's credentials.
   *
   * The single owner of that list, because two paths reach it and they are not
   * the same moment: discovery, and a call made against a session the discovery
   * cache let through uninitialized. A server that fails both — or several calls
   * in one turn — must still be named once, or the run would ask the owner to
   * reconnect the same server three times.
   */
  private recordUnauthorized(serverName: string): void {
    if (!this._unauthorizedServers.includes(serverName)) {
      this._unauthorizedServers.push(serverName);
    }
  }

  /**
   * Narrow a server's tools to the binding's allowlist, keeping the server's own
   * order so aliases stay deterministic. A name the allowlist asks for but the
   * server no longer offers is reported: it is a binding that has silently
   * stopped doing what it says.
   */
  private selectOffered(server: McpServerConfig, discovered: McpTool[]): McpTool[] {
    const allowed = server.tools;
    if (!allowed || allowed.length === 0) {
      return discovered;
    }
    const wanted = new Set(allowed);
    const offered = discovered.filter((tool) => wanted.has(tool.name));
    const missing = allowed.filter((name) => !discovered.some((tool) => tool.name === name));
    if (missing.length > 0) {
      this._warnings.push(
        `MCP server '${server.name}' no longer offers ${missing.map((name) => `'${name}'`).join(", ")}; that selection was skipped.`,
      );
    }
    return offered;
  }

  /**
   * Release every server-side session. Call once the run is over (in a
   * `finally`); best-effort, never throws.
   */
  async close(): Promise<void> {
    const sessions = this.sessions.splice(0);
    await Promise.all(sessions.map((session) => session.end()));
  }

  /**
   * Dispatch one tool. Failures are returned as text, never thrown, and always
   * carry the `Error: ` prefix every tool-result producer in the codebase uses —
   * it is what marks a result as a failure downstream (the trace recorder keys
   * on it). A server's own `isError` verdict is reported the same way, so the
   * model cannot read a failed call as a successful one.
   */
  async callTool(aliasName: string, args: Record<string, unknown>): Promise<McpToolResult> {
    this.signal?.throwIfAborted();
    const session = this.sessionByToolName.get(aliasName);
    const originalName = this.originalNameByAlias.get(aliasName);
    if (!session || !originalName) {
      return { text: `Error: tool call failed. No MCP server provides the tool '${aliasName}'.` };
    }
    const serverName = this.serverNameByAlias.get(aliasName) ?? "unknown";
    try {
      const result = (await session.callTool(
        originalName,
        args,
        this.toolByAlias.get(aliasName),
      )) as
        | {
            content?: unknown[];
            isError?: boolean;
            resultType?: string;
            structuredContent?: unknown;
          }
        | undefined;
      // A server that needs something more before it can answer — an approval, a
      // missing argument, a completion — says so with this instead of content
      // (MRTR, protocol `2026-07-28`). Named here rather than left to the check
      // below, which would report a server behaving exactly as its protocol says
      // it should as one that answered with nothing. An older server omits the
      // field, and the spec requires that to be read as an ordinary result,
      // which is what passing it through already does.
      if (result?.resultType === "input_required") {
        return {
          text:
            `Error: tool call failed. The MCP server needs more input before it can answer ` +
            `'${originalName}' (a multi round-trip request); this client cannot supply it, so ` +
            `the call did not complete.`,
        };
      }
      if (result && Array.isArray(result.content) && result.content.length > 0) {
        const output = formatToolResult(result.content);
        // A failed call's images are dropped: the text is the diagnosis, and
        // attaching a picture to a failure only spends context.
        return result.isError === true ? { text: asErrorResult(output.text) } : output;
      }
      // The spec asks a server returning structured data to *also* serialize it
      // into a text block, but only with a SHOULD — so a server that skips it is
      // conforming enough to be worth reading. Without this its result arrived as
      // "no content", which is a failure report about a call that succeeded.
      if (result?.structuredContent !== undefined) {
        const text = truncateResult(JSON.stringify(result.structuredContent));
        return { text: result.isError === true ? asErrorResult(text) : text };
      }
      if (result?.isError === true) {
        // The server said the call failed and gave nothing to say why. Reporting
        // the emptiness instead of the verdict loses the one fact it stated.
        return {
          text: `Error: the tool reported a failure but returned nothing to explain it ('${originalName}' on MCP server '${serverName}').`,
        };
      }
      if (result && Array.isArray(result.content)) {
        // A well-formed answer that is genuinely empty — a delete that removed
        // something, a write that returns nothing. Not a failure, and this used
        // to reach the model as the string "[]".
        return { text: "(the tool returned no content)" };
      }
      return {
        text: `Error: tool call failed. No content from MCP server '${serverName}' for tool '${originalName}'.`,
      };
    } catch (error) {
      this.signal?.throwIfAborted();
      if (isUnauthorized(error)) {
        // Discovery is cached, so a run whose cache is warm makes its first
        // request *here* — meaning this is the only place a token revoked since
        // the last discovery can surface. Recorded so the console offers a
        // reconnect instead of leaving the owner to re-diagnose it every run.
        this.recordUnauthorized(serverName);
      }
      const message = error instanceof Error ? error.message : String(error);
      return {
        text: `Error: tool call failed. '${originalName}' on MCP server '${serverName}': ${message}`,
      };
    }
  }
}

/**
 * The name a provider will accept, for a tool its server calls something else.
 *
 * MCP allows up to 128 characters and a dot — `admin.tools.list` is the spec's
 * own example — while a provider's function name is `[A-Za-z0-9_-]{1,64}`. The
 * two disagree, and refusing the difference used to cost a run every tool whose
 * name carried a dot. The alias machinery collisions already need is what makes
 * the difference survivable: `originalNameByAlias` keeps the server's own name,
 * so nothing about this reaches the wire.
 */
function providerToolName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

function invalidToolReason(tool: McpTool): string | undefined {
  // A name with nothing a provider accepts cannot be aliased into one — and an
  // absent name used to pass this check as the string "undefined".
  if (typeof tool.name !== "string" || providerToolName(tool.name) === "") {
    return "the name must contain at least one letter, digit, underscore or hyphen";
  }
  if (
    tool.inputSchema !== undefined &&
    (typeof tool.inputSchema !== "object" ||
      tool.inputSchema === null ||
      Array.isArray(tool.inputSchema) ||
      (tool.inputSchema.type !== undefined && tool.inputSchema.type !== "object") ||
      (tool.inputSchema.properties !== undefined &&
        (typeof tool.inputSchema.properties !== "object" ||
          tool.inputSchema.properties === null ||
          Array.isArray(tool.inputSchema.properties))))
  ) {
    return "inputSchema must be an object JSON schema";
  }
  return undefined;
}

/** Return a unique alias; suffix `{name}_{n}` on collision (n from 1). */
function allocateToolName(
  originalName: string,
  usedNames: Set<string>,
  aliasIndexByName: Map<string, number>,
): string {
  if (!usedNames.has(originalName)) {
    usedNames.add(originalName);
    return originalName;
  }
  let index = aliasIndexByName.get(originalName) ?? 1;
  let suffix = `_${index}`;
  let alias = `${originalName.slice(0, 64 - suffix.length)}${suffix}`;
  while (usedNames.has(alias)) {
    index += 1;
    suffix = `_${index}`;
    alias = `${originalName.slice(0, 64 - suffix.length)}${suffix}`;
  }
  aliasIndexByName.set(originalName, index + 1);
  usedNames.add(alias);
  return alias;
}

/**
 * One content block as the model will read it, plus the bytes when the block is
 * a picture. The text placeholder still stands in for the image inside the tool
 * result, because a `tool` message cannot carry an image part — the engine
 * attaches the bytes to the turn and names them there.
 */
interface ExtractedBlock {
  text: string;
  image?: ImageBytes;
  /** Bytes that are not an image and not text — a rendered document, an export. */
  file?: { b64: string; mimeType: string; name: string };
}

/**
 * A `resource_link` as the model will read it: the URI first, then whatever the
 * server offered to identify it. Only the URI is required of the block, and it
 * is the only part that can be acted on — the rest is there so the model can
 * decide whether to.
 */
function resourceLinkText(link: {
  uri?: string;
  name?: string;
  description?: string;
  mimeType?: string;
}): string {
  if (!link.uri) {
    return "Invalid resource link: missing uri";
  }
  const detail = [link.name, link.mimeType, link.description].filter(Boolean).join(", ");
  return detail ? `[resource: ${link.uri} (${detail})]` : `[resource: ${link.uri}]`;
}

/**
 * What to call a file the server did not name.
 *
 * The URI's last segment is what a browser would use; failing that the mime
 * type's subtype makes an extension. Never empty — the name is what a person
 * ends up downloading.
 */
/**
 * How much of a name is kept.
 *
 * A URI path segment has no length limit, and this name is stored on a chat
 * message — one DynamoDB item, capped at 400KB — four times over at worst. Long
 * enough that a real filename is never cut, short enough that a pathological one
 * costs nothing.
 */
const MAX_FILE_NAME_CHARS = 120;

/**
 * A name that came from somewhere else, made safe to carry.
 *
 * The URI belongs to the server, and the name taken out of it travels a long
 * way: into the tool result the model reads, onto the artifact row, and into the
 * `Content-Disposition` of the download a person clicks. Each rule here answers
 * something a server can send today.
 *
 * `decodeURIComponent` is the sharp one. It **throws** on a lone `%` — the
 * segment `report%.pdf` is enough — and this runs while formatting a call that
 * *succeeded*, inside the `catch` that turns anything thrown into
 * `Error: tool call failed`. A server that rendered the document correctly was
 * reported as having failed, and the file went with the report.
 *
 * Nothing here is path traversal defence: the object key is derived from a UUID,
 * so the name never addresses anything. It is that a name is *shown* — a newline
 * in one reads as two lines everywhere it appears, and a `/` claims a directory
 * structure that does not exist.
 */
function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[/\\]/g, "_")
    .trim();
  if (cleaned === "" || cleaned === "." || cleaned === "..") {
    return "";
  }
  if (cleaned.length <= MAX_FILE_NAME_CHARS) {
    return cleaned;
  }
  // Keep the extension across the cut: a truncated name that still says what
  // type it is remains something a reader can open.
  const dot = cleaned.lastIndexOf(".");
  const extension = dot > 0 && cleaned.length - dot <= 12 ? cleaned.slice(dot) : "";
  return cutCodePoints(cleaned, MAX_FILE_NAME_CHARS - extension.length) + extension;
}

function fileNameFor(resource: { uri?: string }, mimeType: string): string {
  const segment = resource.uri?.split("?")[0]?.split("/").filter(Boolean).pop();
  let decoded = "";
  if (segment) {
    try {
      decoded = safeFileName(decodeURIComponent(segment));
    } catch {
      // Malformed percent-escapes. The raw segment still names the file better
      // than the mime fallback does, and failing the call over it is the one
      // outcome that helps nobody.
      decoded = safeFileName(segment);
    }
  }
  if (decoded) {
    return decoded;
  }
  const subtype = mimeType.split("/")[1]?.split(/[+.]/).pop();
  return subtype ? `file.${safeFileName(subtype) || "bin"}` : "file";
}

/**
 * The media type without its parameters, lowercased.
 *
 * A server is free to answer `image/png; charset=binary`, and until here the
 * whole string travelled. It becomes `data:image/png; charset=binary;base64,…`
 * — not a valid data URL, and the turn it rides on is the thing that fails — and
 * it becomes the artifact's media type, where nothing matches it and the object
 * is stored as `.bin`. `documentKind` has always read a declared type this way;
 * this is the same reading, applied where the value arrives from someone else.
 */
function baseMediaType(value: string | undefined): string {
  return value?.split(";")[0]?.trim().toLowerCase() ?? "";
}

/**
 * A picture a server returned, if a provider will take it.
 *
 * The size check is the same one a person's attachment meets, and it belongs
 * here for the same reason it belongs there: `MAX_ATTACHMENT_BYTES` is a bound
 * *providers* impose, so where the bytes came from does not change it. Only the
 * upload path enforced it, so a tool could hand back a picture no model would
 * accept — the count budget downstream bounds how many images a turn carries and
 * has never had anything to say about how large one is. What that cost was the
 * whole turn: the image rides on the next user message, and a provider refusing
 * it fails the request rather than the picture.
 *
 * Reported rather than dropped, in the shape an oversize blob already uses, so a
 * model told the picture was too big can ask for a smaller rendition — which it
 * cannot do about one it never learned existed.
 */
function imageBlock(data: string | undefined, declaredType: string | undefined): ExtractedBlock {
  const mimeType = baseMediaType(declaredType);
  if (!data || !mimeType.startsWith("image/")) {
    return { text: "[image result omitted]" };
  }
  const bytes = base64ByteLength(data);
  if (bytes > MAX_ATTACHMENT_BYTES) {
    return {
      text: `[image omitted: ${mimeType}, ${bytes} bytes — over the ${MAX_ATTACHMENT_BYTES}-byte limit for one image. Ask the server for a smaller rendition.]`,
    };
  }
  return { text: "[image]", image: { b64: data, mimeType } };
}

function extractBlock(block: unknown): ExtractedBlock {
  if (!block || typeof block !== "object") {
    return { text: "Invalid content" };
  }
  const b = block as {
    type?: string;
    text?: string;
    data?: string;
    mimeType?: string;
    uri?: string;
    name?: string;
    description?: string;
    // `uri` is required of an embedded resource by the protocol, and it is
    // what names a file the server handed back.
    resource?: { uri?: string; text?: string; blob?: string; mimeType?: string };
  };
  if (b.type === "text") {
    return { text: b.text || "No result" };
  }
  if (b.type === "image") {
    return imageBlock(b.data, b.mimeType);
  }
  if (b.type === "audio") {
    // Nothing downstream takes audio — a turn carries text and images — so the
    // bytes stop here. Named rather than dropped: a model told a recording came
    // back can ask the server for a transcript, which it cannot do about a block
    // it never learned existed.
    return {
      text: `[audio omitted: ${b.mimeType ?? "unknown type"} — this client cannot pass audio to the model. Ask the server for a text transcript.]`,
    };
  }
  if (b.type === "resource_link") {
    // A pointer rather than a payload: the server is naming something it can be
    // asked for by URI. The URI is the actionable part, so it leads.
    return { text: resourceLinkText(b) };
  }
  if (b.type === "resource" && b.resource) {
    if (b.resource.text != null) {
      return { text: b.resource.text || "No result" };
    }
    if (b.resource.blob != null) {
      const mime = baseMediaType(b.resource.mimeType) || "application/octet-stream";
      if (mime.startsWith("image/")) {
        return imageBlock(b.resource.blob, mime);
      }
      const bytes = Buffer.from(b.resource.blob, "base64");
      const text = decodeUtf8Text(bytes);
      if (text !== null) {
        return { text: text || "No result" };
      }
      if (bytes.byteLength <= MAX_TOOL_FILE_BYTES) {
        // Not text, but not nothing either: a rendered document is the whole
        // answer to the call that produced it, and dropping it here is what
        // used to make "write me a report" end with a file nobody received.
        //
        // Every blob within the cap, rather than a mime allowlist: the protocol
        // has no field that says "this is an artifact", and a list of types
        // would be wrong the first time a `.xlsx` arrives. This code already
        // distrusts the declared type — see the comment below.
        const name = fileNameFor(b.resource, mime);
        return {
          text: `[file: ${name}, ${mime}, ${bytes.byteLength} bytes — delivered to the user]`,
          file: { b64: b.resource.blob, mimeType: mime, name },
        };
      }
      // Decided on the bytes, not on `mime`: servers label a real PDF
      // `application/octet-stream` often enough that the declared type cannot
      // carry this, and they label text as octet-stream too.
      //
      // This branch used to be a `catch`, which could never run —
      // `toString("utf-8")` turns arbitrary bytes into replacement characters
      // rather than throwing — so a PDF arrived as a page of U+FFFD presented as
      // a successful result. Said plainly instead, in the same shape an omitted
      // image takes, so a multi-block result still composes.
      return {
        text: `[binary resource omitted: ${mime}, ${bytes.byteLength} bytes — not text, so it cannot be read here. Ask the server for a text representation.]`,
      };
    }
    return { text: "Invalid resource content: missing text and blob" };
  }
  // Deliberately not "invalid": the protocol keeps gaining content types, and a
  // server sending one this client has not learned yet is ahead of it rather
  // than wrong. Saying which type arrived is what lets that be told apart from a
  // server returning nonsense.
  return { text: `[unsupported content type '${b.type}' — this client could not read it]` };
}

/** Mark a payload as a failure without stuttering when it already says so. */
function asErrorResult(output: string): string {
  return output.startsWith("Error:") ? output : `Error: the tool reported a failure. ${output}`;
}

/**
 * The per-call ceiling, applied wherever a result becomes text.
 *
 * `cutCodePoints`, not `slice`: this is the largest cut in the file and was the
 * only one that did not use it, while eight others do. A raw slice can land
 * between the halves of a non-BMP character — an emoji, CJK ext-B — and what
 * comes back is not well-formed text at all, so it reaches the model's context
 * and DynamoDB as a lone surrogate.
 *
 * The suffix counts characters because that is what the limit counts. It used to
 * say "100KB", which was never the same number and drifted further with every
 * Korean character in the result.
 */
function truncateResult(output: string): string {
  return output.length > MAX_TOOL_RESULT_LENGTH
    ? `${cutCodePoints(output, MAX_TOOL_RESULT_LENGTH)}...(truncated at ${MAX_TOOL_RESULT_LENGTH.toLocaleString("en-US")} characters)`
    : output;
}

/** Exported for tests: how a server's content blocks become one tool result. */
export function formatToolResult(content: unknown[]): McpToolResult {
  const blocks = content.map(extractBlock);
  const images = blocks.flatMap((block) => (block.image ? [block.image] : []));
  // Not a `slice`. Each file block wrote "delivered to the user" into its own
  // text before the cap was applied, so cutting the list afterwards left the
  // model reading a delivery note for a file nobody received — and repeating it
  // to the reader. A dropped file says it was dropped, in its own place, which
  // is the same rule truncation follows everywhere else here.
  const files: NonNullable<ExtractedBlock["file"]>[] = [];
  const data: string[] = [];
  for (const block of blocks) {
    if (!block.file) {
      data.push(block.text);
    } else if (files.length < MAX_TOOL_FILES_PER_RESULT) {
      files.push(block.file);
      data.push(block.text);
    } else {
      data.push(
        `[file omitted: ${block.file.name} — one result may carry ${MAX_TOOL_FILES_PER_RESULT} files and this one is past that. Ask for the rest in another call.]`,
      );
    }
  }
  const first = data[0];
  const output = truncateResult(
    data.length === 1 && first !== undefined ? first : JSON.stringify(data),
  );
  return {
    text: output,
    ...(images.length > 0 ? { images } : {}),
    ...(files.length > 0 ? { files } : {}),
  };
}
