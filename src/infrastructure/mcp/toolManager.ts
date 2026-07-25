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

import type { ChannelToolDef } from "@/domain/llm/channel";
import type { ImageBytes } from "@/domain/llm/imageChannel";
import type { McpToolResult } from "@/domain/llm/types";
import { getCachedTools, setCachedTools } from "./discoveryCache";
import { McpSession, type McpTool } from "./session";

const MAX_TOOL_RESULT_LENGTH = 100_000;

export interface McpServerConfig {
  name: string;
  url: string;
  /** Already-decrypted outbound headers. */
  headers: Record<string, string>;
  /** Offer only these of the server's tools; absent/empty means all of them. */
  tools?: string[];
}

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
        const session = new McpSession(server.url, server.headers, this.signal);
        // Registered before the first request: a session that initializes and
        // then fails — or one abandoned when the run aborts mid-discovery —
        // must still be reachable by `close()`, or it is leaked server-side.
        this.sessions.push(session);
        const cached = getCachedTools(server.url, server.headers);
        if (cached) {
          // The session stays uninitialized; it handshakes on its first actual
          // tool call, so a run that calls nothing makes no request at all.
          return { server, session, tools: cached };
        }
        try {
          const tools = await session.listTools();
          setCachedTools(server.url, server.headers, tools);
          return { server, session, tools };
        } catch (error) {
          // A single broken MCP must not abort the whole tool set — but it must
          // not vanish either: without this the tools are simply absent and the
          // run looks like a model that ignored them.
          const reason = error instanceof Error ? error.message : String(error);
          console.warn(
            `[mcp] discovery failed for '${server.name}' (${server.url}); its tools are unavailable this run:`,
            reason,
          );
          this._warnings.push(`MCP server '${server.name}' is unreachable (${reason}); its tools are unavailable this run.`);
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
      const offered = this.selectOffered(entry.server, entry.tools);
      const aliases: string[] = [];
      for (const tool of offered) {
        const alias = allocateToolName(tool.name, usedNames, aliasIndexByName);
        tools.push({
          type: "function",
          function: {
            name: alias,
            description: tool.description,
            parameters: tool.inputSchema ?? { type: "object", properties: {} },
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
  let alias = `${originalName}_${index}`;
  while (usedNames.has(alias)) {
    index += 1;
    alias = `${originalName}_${index}`;
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
