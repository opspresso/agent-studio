/**
 * MCP tool manager. Builds a run's tool set over {@link McpSession}, which owns
 * the protocol. Behaviours:
 *   - tool-name collision aliasing (`name_1`, `name_2`) with a reverse mapping,
 *   - builtin reserved names are seeded so only MCP tools get suffixed,
 *   - results capped at 100,000 chars; multi-block results JSON-stringified,
 *   - failures (transport, JSON-RPC, and the server's own `isError`) come back as
 *     `Error: …` text, never thrown: the model reads them as a tool result and
 *     the trace recorder reads the prefix as a failed span,
 *   - a server that cannot be reached loses only its own tools, and the reason
 *     is reported through {@link ToolManager.warnings} so the run can surface it,
 *   - discovery is served from {@link ../discoveryCache the discovery cache} when
 *     it is warm, which also leaves the session to handshake lazily on its first
 *     tool call — a turn that calls nothing then makes no MCP request at all,
 *     and a turn that calls several at once still handshakes exactly once
 *     ({@link ./session McpSession} serializes it).
 */

import type { McpServerConfig } from "@/domain/mcp/toolSession";
import type { ChannelToolDef } from "@/domain/llm/channel";
import type { ImageBytes } from "@/domain/llm/imageChannel";
import type { McpToolResult } from "@/domain/llm/types";
import { getCachedDiscovery, setCachedFailure, setCachedTools } from "./discoveryCache";
import { McpHttpError, McpSession, type McpTool } from "./session";
import { log } from "@/shared/logger";

const MAX_TOOL_RESULT_LENGTH = 100_000;
const PROVIDER_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export type { McpServerConfig };

export class ToolManager {
  private readonly servers: McpServerConfig[];
  private readonly reservedToolNames: Set<string>;
  private readonly sessionByToolName = new Map<string, McpSession>();
  private readonly originalNameByAlias = new Map<string, string>();
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
        const session = new McpSession(server.url, server.headers, this.signal, server.loopback);
        // Registered before the first request: a session that initializes and
        // then fails — or one abandoned when the run aborts mid-discovery —
        // must still be reachable by `close()`, or it is leaked server-side.
        this.sessions.push(session);
        const cached = getCachedDiscovery(server.url, server.headers);
        if (cached?.kind === "tools") {
          // The session stays uninitialized; it handshakes on its first actual
          // tool call, so a run that calls nothing makes no request at all.
          return { server, session, tools: cached.tools };
        }
        if (cached?.kind === "failure") {
          // Replayed rather than re-attempted: without this a server that is
          // down re-pays a failing handshake before the first token of every
          // message. The reason is the live one, so the run explains itself the
          // same way it did when the failure actually happened.
          this.recordFailure(server.name, cached.reason, cached.unauthorized);
          return null;
        }
        try {
          const { tools, ttlMs } = await session.listTools();
          setCachedTools(server.url, server.headers, tools, ttlMs);
          return { server, session, tools };
        } catch (error) {
          // A single broken MCP must not abort the whole tool set — but it must
          // not vanish either: without this the tools are simply absent and the
          // run looks like a model that ignored them.
          const reason = error instanceof Error ? error.message : String(error);
          log.warn(
            "mcp",
            `discovery failed for '${server.name}' (${server.url}); its tools are unavailable this run:`,
            reason,
          );
          const unauthorized = error instanceof McpHttpError && error.status === 401;
          setCachedFailure(server.url, server.headers, reason, unauthorized);
          this.recordFailure(server.name, reason, unauthorized);
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
        // The one outcome that would otherwise explain nothing: the handshake
        // succeeded, `tools/list` answered, and the answer was empty. Left
        // silent, the server vanishes from the run — no error, no tools, and no
        // row in the system prompt's server table — with nothing to tell an
        // operator apart a server that offers nothing from one this app
        // dropped. Say it, so they go and look at the server.
        this._warnings.push(
          `MCP server '${entry.server.name}' is connected but offers no tools; a run has nothing to call on it.` +
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
        const alias = allocateToolName(tool.name, usedNames, aliasIndexByName);
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
  private recordFailure(serverName: string, reason: string, unauthorized: boolean): void {
    if (unauthorized) {
      this._unauthorizedServers.push(serverName);
      this._warnings.push(
        `MCP server '${serverName}' rejected this project's credentials; it needs to be reconnected before its tools are available.`,
      );
      return;
    }
    this._warnings.push(
      `MCP server '${serverName}' is unreachable (${reason}); its tools are unavailable this run.`,
    );
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
    try {
      const result = (await session.callTool(originalName, args)) as
        | { content?: unknown[]; isError?: boolean }
        | undefined;
      if (!result || !Array.isArray(result.content)) {
        return {
          text: `Error: tool call failed. No content from MCP for tool '${originalName}'.`,
        };
      }
      const output = formatToolResult(result.content);
      // A failed call's images are dropped: the text is the diagnosis, and
      // attaching a picture to a failure only spends context.
      return result.isError === true ? { text: asErrorResult(output.text) } : output;
    } catch (error) {
      this.signal?.throwIfAborted();
      const message = error instanceof Error ? error.message : String(error);
      return { text: `Error: tool call failed. ${message}` };
    }
  }
}

function invalidToolReason(tool: McpTool): string | undefined {
  if (!PROVIDER_TOOL_NAME.test(tool.name)) {
    return "the name must be 1-64 letters, digits, underscores, or hyphens";
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
}

function imageBlock(data: string | undefined, mimeType: string | undefined): ExtractedBlock {
  if (!data || !mimeType?.startsWith("image/")) {
    return { text: "[image result omitted]" };
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
    resource?: { text?: string; blob?: string; mimeType?: string };
  };
  if (b.type === "text") {
    return { text: b.text || "No result" };
  }
  if (b.type === "image") {
    return imageBlock(b.data, b.mimeType);
  }
  if (b.type === "resource" && b.resource) {
    if (b.resource.text != null) {
      return { text: b.resource.text || "No result" };
    }
    if (b.resource.blob != null) {
      const mime = b.resource.mimeType ?? "application/octet-stream";
      if (mime.startsWith("image/")) {
        return imageBlock(b.resource.blob, mime);
      }
      try {
        return { text: Buffer.from(b.resource.blob, "base64").toString("utf-8") };
      } catch {
        return { text: `Unsupported binary resource (mimeType: ${mime})` };
      }
    }
    return { text: "Invalid resource content: missing text and blob" };
  }
  return { text: `Invalid content type: ${b.type}` };
}

/** Mark a payload as a failure without stuttering when it already says so. */
function asErrorResult(output: string): string {
  return output.startsWith("Error:") ? output : `Error: the tool reported a failure. ${output}`;
}

function formatToolResult(content: unknown[]): McpToolResult {
  const blocks = content.map(extractBlock);
  const data = blocks.map((block) => block.text);
  const images = blocks.flatMap((block) => (block.image ? [block.image] : []));
  const first = data[0];
  let output: string;
  if (data.length === 1 && first !== undefined) {
    output = first;
  } else {
    output = JSON.stringify(data);
  }
  if (output.length > MAX_TOOL_RESULT_LENGTH) {
    output = `${output.slice(0, MAX_TOOL_RESULT_LENGTH)}...(truncated after 100KB)`;
  }
  return images.length > 0 ? { text: output, images } : { text: output };
}
