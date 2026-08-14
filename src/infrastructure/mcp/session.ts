/**
 * One connection to a single MCP server, over `@modelcontextprotocol/client`.
 *
 * The single owner of the protocol. Both callers use it: the engine's
 * {@link ../toolManager ToolManager} for a run's tools, and the registry's
 * "Test connection" probe. A second implementation had already drifted from
 * this one on headers, framing and timeouts.
 *
 * **This client speaks revision `2026-07-28` and nothing else.** No probe, no
 * `initialize` fallback: every connection states the pinned revision and a
 * server that does not offer it is refused, with the reason said out loud. The
 * revision it drops was not a small one to keep — a handshake, a session id, the
 * expiry recovery around it, and a whole second shape for every request — and
 * carrying both is what makes a client quietly wrong in the seams between them.
 *
 * **Why an SDK here, when `application` may name none.** This is the adapter
 * layer, where a protocol client belongs, and this revision is not small either:
 * the per-request `_meta` envelope, `Mcp-Param-*` mirroring from a tool's own
 * schema, `server/discover`, multi round-trip results.
 *
 * What this file keeps is everything the SDK has no opinion about, and each of
 * these was a defect once: the SSRF guard the deployment requires
 * ({@link boundedFetch}), a ceiling on what one response may pull into memory,
 * and the fact that a session connects lazily so a turn calling no tool makes
 * no request at all.
 */

import {
  Client,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  UnsupportedProtocolVersionError,
  type FetchLike,
  type Tool,
} from "@modelcontextprotocol/client";
import type { McpTool } from "@/domain/mcp/types";
export type { McpTool };
import { fetchPublicUrl } from "@/infrastructure/net/publicFetch";
import { cutCodePoints } from "@/shared/utf8Text";
import { withTimeout } from "@/shared/withTimeout";

/**
 * The revision this client speaks. Pinned, not proposed: a server offering
 * anything else is refused rather than met half-way.
 *
 * Written here rather than taken from the SDK, whose `LATEST_PROTOCOL_VERSION`
 * names the newest *legacy* revision — the one it would offer in a handshake
 * this client no longer performs.
 */
export const PROTOCOL_VERSION = "2026-07-28";

/** A tool may legitimately take minutes; the model is waiting on its answer. */
export const MCP_CALL_TIMEOUT_MS = 120_000;
/**
 * Discovery is on the critical path of *every* run's first token, and a server
 * that accepts the connection but never answers would otherwise hold the whole
 * run for the call timeout. Failing fast only costs that server's tools.
 */
export const MCP_DISCOVERY_TIMEOUT_MS = 10_000;
/** Cleanup runs after the answer is delivered; keep it short. */
const SESSION_END_TIMEOUT_MS = 5_000;
/**
 * Pages of `tools/list` to follow. A bound rather than a `while (cursor)`: the
 * cursor is opaque, so a server that keeps handing back a fresh one — by bug or
 * by design — would spin here on the critical path of a run's first token.
 *
 * Reaching it now **fails the discovery** rather than returning the pages
 * already walked: the SDK throws on the cap and caches no partial aggregate,
 * where the hand-rolled walk returned what it had and warned about the tail. So
 * the bound is no longer free, and it sits at the SDK's own default rather than
 * below it — a catalogue of 21 pages should not cost a server all of its tools.
 * The discovery deadline is the real defence against a cursor that never
 * converges; this is the backstop behind it.
 */
const MAX_TOOL_PAGES = 64;
/**
 * How many bytes one response may pull into memory.
 *
 * Ours to impose, and the SDK does not: it reads a response to completion, so a
 * server answering `tools/list` with something enormous — by bug, by compromise,
 * or because a tool really did return a database — would be held whole before
 * anything got to judge it.
 */
const MAX_MCP_RESPONSE_BYTES = 14_500_000;

/** How this client names itself to a server. */
const CLIENT_INFO = { name: "agentdure", version: "0.1.0" } as const;

/**
 * What one discovery learned: the catalogue, and how long the server says it
 * stays fresh.
 *
 * `ttlMs` is the MCP caching hint (SEP-2549, required of servers from protocol
 * `2026-07-28`). Absent from every older server, which is why the caller keeps
 * a default of its own rather than reading absence as "do not cache".
 */
export interface McpDiscovery {
  tools: McpTool[];
  ttlMs?: number;
}

/**
 * The deployment's outbound fetch, with a ceiling on what one response may
 * bring back.
 *
 * Both halves are this file's to supply. The guard is not defence in depth —
 * an MCP URL is operator-supplied, and `fetchPublicUrl` is what keeps it from
 * naming the metadata service or a neighbour on the cluster network. The
 * ceiling is applied to the stream rather than after it, because "read it and
 * check the length" spends the memory before it decides.
 */
function boundedFetch(loopback: boolean, runSignal: () => AbortSignal | undefined): FetchLike {
  const send = loopback ? fetch : fetchPublicUrl;
  return async (url, init) => {
    const response = await send(url, withSignal(init, runSignal()));
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_MCP_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => {});
      throw new Error(
        `MCP response declares ${declared} bytes, over the ${MAX_MCP_RESPONSE_BYTES} cap`,
      );
    }
    if (!response.body) {
      return response;
    }
    let total = 0;
    const bounded = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          total += chunk.byteLength;
          if (total > MAX_MCP_RESPONSE_BYTES) {
            controller.error(new Error(`MCP response exceeds ${MAX_MCP_RESPONSE_BYTES} bytes`));
            return;
          }
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(bounded, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

/**
 * The request, cancelled by the run as well as by whatever the SDK asked for.
 *
 * The SDK forwards a caller's `signal` to the transport only where the
 * connection has a per-request stream, and never to the era probe that opens
 * one. Merging it here is what makes a cancelled run stop talking rather than
 * hold a socket until the server answers or the deadline passes.
 */
function withSignal(init: RequestInit | undefined, signal: AbortSignal | undefined): RequestInit {
  if (!signal) {
    return init ?? {};
  }
  const own = init?.signal;
  return { ...init, signal: own ? AbortSignal.any([own, signal]) : signal };
}

export class McpSession {
  private client: Client | undefined;
  private transport: StreamableHTTPClientTransport | undefined;
  /** The connection while it is being made; see {@link ensureConnected}. */
  private connecting: Promise<Client> | undefined;
  /** Name, version and negotiated protocol from the connection; "" until then. */
  private serverDescription = "";

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly signal?: AbortSignal,
    /**
     * An address this deployment vouches for: a container it started, or a host
     * whose suffix it declared internal. `fetchPublicUrl` would reject both on
     * every request — correctly, for anything an operator merely typed — so
     * these use plain fetch instead.
     *
     * Only ever set from `skipsUrlGuard`, which owns that decision and is the
     * only thing entitled to make it; the name predates the second way in.
     * Defaulting to the guarded path means a caller that forgets it loses tools
     * rather than protection.
     */
    private readonly loopback = false,
  ) {}

  /** The per-request options every call shares: the run's signal, and a deadline. */
  private requestOptions(timeoutMs: number): { timeout: number; signal?: AbortSignal } {
    return { timeout: timeoutMs, ...(this.signal ? { signal: this.signal } : {}) };
  }

  /**
   * Connect once, even when several callers arrive together. The MCP calls of
   * one model response are dispatched concurrently, and a session served from
   * the discovery cache is still unconnected when the first of them lands — so
   * without this each racing caller would open its own connection, and every one
   * but the last would be left unreleased. A failed connect clears the memo so
   * the next call may retry.
   */
  private async ensureConnected(): Promise<Client> {
    if (this.client) {
      return this.client;
    }
    this.connecting ??= this.connect();
    try {
      return await this.connecting;
    } catch (error) {
      this.connecting = undefined;
      throw error;
    }
  }

  private async connect(): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL(this.url), {
      fetch: boundedFetch(this.loopback, () => this.signal),
      // The registry entry's own headers — a bearer token, a tenant id. Applied
      // as transport defaults so every request carries them, including the
      // era probe, which is the first request a server ever sees from us.
      requestInit: { headers: this.headers },
    });
    const client = new Client(CLIENT_INFO, {
      // Pinned rather than negotiated: this deployment speaks one revision, so a
      // server that does not offer it is a server this client cannot use, and
      // saying that is worth more than falling back to a shape the rest of this
      // file no longer accounts for. `mode: 'legacy'` is the SDK's default,
      // which would make this a 2025-era client without a word.
      versionNegotiation: { mode: { pin: PROTOCOL_VERSION } },
      // This client answers no elicitation, sampling or roots request: it has
      // no user to ask mid-run. Auto-fulfilment would try the handlers that are
      // not registered; refusing instead lets `callTool` report the one thing
      // that is true — the server needs something we cannot give it.
      inputRequired: { autoFulfill: false },
      listMaxPages: MAX_TOOL_PAGES,
    });
    // Held before the attempt, not after it. A connect that fails partway may
    // already have been given a session id — the handshake answers with one, and
    // a run cancelled at that moment is exactly when it happens — and a
    // transport dropped on the way out strands that session on the server for
    // its whole TTL. `end()` releases whatever this turns out to hold.
    this.transport = transport;
    try {
      await client.connect(transport, this.requestOptions(MCP_DISCOVERY_TIMEOUT_MS));
    } catch (error) {
      throw asMcpError(error, "connect");
    }
    this.client = client;
    this.serverDescription = describeServer(client);
    return client;
  }

  /** How the server identified itself when the connection was made. Empty before it happens. */
  get describedAs(): string {
    return this.serverDescription;
  }

  /**
   * Did the server declare that it has tools at all? `undefined` before a
   * connection is made.
   *
   * Asked because the answer is otherwise invisible: the SDK returns an empty
   * list — without sending `tools/list` — for a server that does not declare the
   * `tools` capability, which the spec requires of any server that has them.
   * That is the right reading of a conforming server and a silent loss for a
   * non-conforming one, and a server whose tools simply stopped appearing is the
   * hardest kind of failure to see. The caller reports the difference.
   */
  get declaresTools(): boolean | undefined {
    return this.client ? this.client.getServerCapabilities()?.tools !== undefined : undefined;
  }

  /**
   * Every page of the server's catalogue, not just the first — the SDK walks the
   * `nextCursor` chain, bounded by {@link MAX_TOOL_PAGES}.
   *
   * One thing changed with the SDK and is worth knowing before trusting the
   * hint: the freshness a paged catalogue comes back with is the **first
   * page's**, where this client used to take the shortest of all of them. The
   * per-page call that would let us see the rest is unreachable — the SDK's
   * per-page path is selected by passing a cursor, and the first page has none —
   * so a server whose later pages ask for a shorter life is cached for longer
   * than it asked. Bounded rather than unbounded: `MCP_MAX_SERVER_TTL_MS` caps
   * whatever a server asks for, and a catalogue whose pages disagree about their
   * own lifetime is not a shape any server here produces.
   */
  async listTools(): Promise<McpDiscovery> {
    const client = await this.ensureConnected();
    let result;
    try {
      result = await client.listTools(undefined, this.requestOptions(MCP_DISCOVERY_TIMEOUT_MS));
    } catch (error) {
      throw asMcpError(error, "tools/list");
    }
    const ttlMs = result.ttlMs;
    return {
      tools: result.tools as McpTool[],
      ...(typeof ttlMs === "number" && Number.isFinite(ttlMs) ? { ttlMs } : {}),
    };
  }

  /**
   * Call one tool.
   *
   * `definition` is the tool as the catalogue described it, and passing it is
   * not an optimisation. From protocol `2026-07-28` a parameter the tool marks
   * `x-mcp-header` **must** be mirrored into an `Mcp-Param-*` header, and the
   * client derives that from the tool's `inputSchema` — normally from the
   * `tools/list` it sent itself. This app's discovery cache means it often sent
   * none: a warm entry connects at the first tool call, with nothing behind it
   * to read. The header would then be missing from a request whose body has the
   * value, which a server that routes on it must reject (`-32020`). The caller
   * holds the definition either way, cached or fresh, so it hands it over.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    definition?: McpTool,
  ): Promise<unknown> {
    const client = await this.ensureConnected();
    try {
      return await client.callTool(
        { name, arguments: args },
        {
          ...this.requestOptions(MCP_CALL_TIMEOUT_MS),
          // Take an `input_required` result as a value rather than as a thrown
          // error, so the caller can report *what* the server asked for. This
          // client cannot answer it either way; the difference is whether the
          // model is told why.
          allowInputRequired: true,
          ...(definition ? { toolDefinition: definition as Tool } : {}),
        },
      );
    } catch (error) {
      throw asMcpError(error, "tools/call");
    }
  }

  /**
   * Close the connection. Best-effort, and quiet: this revision has no
   * server-side session, so there is nothing to release and nothing leaves for
   * the network — closing is local. A session that never connected returns at
   * once.
   */
  async end(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.client = undefined;
    this.transport = undefined;
    this.connecting = undefined;
    if (!transport) {
      return;
    }
    try {
      // Whichever end got as far as existing: a connect that threw leaves the
      // transport open with no client above it.
      await withTimeout(client ? client.close() : transport.close(), SESSION_END_TIMEOUT_MS);
    } catch {
      // Closing is best-effort: the run is already over.
    }
  }
}

/** What the server said it is, for a run that needs to name it. */
function describeServer(client: Client): string {
  const info = client.getServerVersion();
  const version = client.getNegotiatedProtocolVersion();
  return [info?.name, info?.version, version ? `protocol ${version}` : undefined]
    .filter(Boolean)
    .join(" ");
}

/**
 * A transport-level failure, carrying the status so callers can tell the one
 * that means something specific from the rest. A 401 is "this connection needs
 * authorization", which asks the operator for something entirely different than
 * "this server is down".
 */
export class McpHttpError extends Error {
  constructor(
    readonly status: number,
    /** The request this failed, kept so a reading may depend on which one it was. */
    readonly method: string,
    message?: string,
  ) {
    super(message ?? `${method} failed: HTTP ${status}`);
    this.name = "McpHttpError";
  }
}

/**
 * How much of a server's failure text a failure may carry.
 *
 * The SDK puts the **entire response body** in the message of a non-OK POST, so
 * a proxy answering with an HTML error page hands over the whole page. That
 * message is not just logged: it becomes the run's warning — text the model and
 * the reader see — and it is cached with the failure and replayed for the next
 * runs. Enough of it to recognise the page, and no more.
 */
const MAX_FAILURE_TEXT_CHARS = 400;

/**
 * The SDK's error vocabulary, in this codebase's.
 *
 * Only the status is translated, and only because one status means something
 * the rest do not (see {@link isUnauthorized}). The message is kept but bounded:
 * it is more specific than anything restating it here would be, and it is also
 * unbounded at the source.
 */
function asMcpError(error: unknown, method: string): unknown {
  if (error instanceof UnauthorizedError) {
    return new McpHttpError(401, method, boundedFailure(method, 401, error.message));
  }
  if (error instanceof SdkHttpError) {
    return new McpHttpError(error.status, method, boundedFailure(method, error.status, error.message));
  }
  return error;
}

/** `method failed: HTTP status — <as much of what the server said as fits>`. */
function boundedFailure(method: string, status: number, message: string): string {
  const said = cutCodePoints(message.replace(/\s+/g, " ").trim(), MAX_FAILURE_TEXT_CHARS);
  return said ? `${method} failed: HTTP ${status} — ${said}` : `${method} failed: HTTP ${status}`;
}

/**
 * Did this failure come from a deadline rather than from the server?
 *
 * The SDK rejects every timeout and abort as `SdkError(RequestTimeout)`, whose
 * `name` is `"SdkError"` — so a caller matching the DOM's `TimeoutError` /
 * `AbortError` names, which is what the registry probe did, silently stopped
 * recognising any of them. Both shapes are answered here because the run's own
 * signal can still surface as the DOM one.
 */
export function isTimeout(error: unknown): boolean {
  if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) {
    return true;
  }
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

/**
 * Does this failure mean the connection has to be authorized again?
 *
 * The single owner of that reading, because what it asks for is unlike every
 * other failure: a 401 asks the *project* to reconnect, while the rest ask an
 * operator to go and look at the server. Three places need the answer —
 * discovery, a tool call made against a session the discovery cache let through
 * unconnected, and the registry's probe — and each used to spell the pair out
 * for itself, so a fourth was free to get either half of it subtly wrong.
 */
export function isUnauthorized(error: unknown): boolean {
  return error instanceof McpHttpError && error.status === 401;
}

/**
 * Is this server answering, but in a way this client cannot use?
 *
 * The distinction the caller needs, because "unreachable" sends an operator to
 * check a host that is up and replying. Two failures are of this kind, and
 * neither is fixed by looking at the network:
 *
 * - a server supporting only revisions newer than this client, which answers
 *   `-32022` naming what it does speak. The probe cannot rescue this one — the
 *   era gap it *can* cross is the older direction.
 * - a server whose reply breaks the schema. The client validates a whole
 *   result, so one tool with a non-object `inputSchema` costs that server its
 *   entire catalogue. Strictly a behaviour change from the hand-rolled client,
 *   which read what it could and dropped the rest; the trade is that a
 *   malformed answer is now named instead of silently thinned.
 *
 * Returns the sentence to report, or `undefined` for an ordinary failure.
 */
export function unusableServerReason(error: unknown): string | undefined {
  if (error instanceof UnsupportedProtocolVersionError) {
    const supported = supportedVersions(error);
    const speaks =
      supported.length > 0
        ? `It supports only MCP ${supported.join(", ")}`
        : "It supports no MCP revision this client knows";
    return `${speaks}, which this client cannot speak: its SDK needs upgrading.`;
  }
  if (error instanceof SdkError && error.code === SdkErrorCode.InvalidResult) {
    return `It answered with something this client could not read (${error.message}).`;
  }
  if (error instanceof SdkError && error.code === SdkErrorCode.EraNegotiationFailed) {
    // Two very different failures share this code, and the difference is
    // whether anything underneath went wrong: a probe that could not be *sent*
    // carries the cause, and a server that is down or unroutable must keep
    // being reported as one. Only a probe the server answered — declining the
    // pinned revision — belongs here.
    if ((error as { data?: { cause?: unknown } }).data?.cause !== undefined) {
      return undefined;
    }
    // The common one now: a server still speaking a 2025-era revision, which
    // answers the probe with "no such method". It is running and correct — for
    // the revision it implements — so what this asks for is that server being
    // upgraded, not an operator checking whether it is up.
    return (
      `It does not offer MCP ${PROTOCOL_VERSION}, which is the only revision this client ` +
      `speaks (${error.message}).`
    );
  }
  if (error instanceof SdkError && error.code === SdkErrorCode.ListPaginationExceeded) {
    return (
      `Its catalogue did not finish within ${MAX_TOOL_PAGES} pages, so none of it could be ` +
      `used: a cursor that never converges cannot be read part-way.`
    );
  }
  return undefined;
}

/** The `supported` list an `UnsupportedProtocolVersion` refusal carries, if any. */
function supportedVersions(error: UnsupportedProtocolVersionError): string[] {
  const data: unknown = (error as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) {
    return [];
  }
  const supported = (data as { supported?: unknown }).supported;
  if (!Array.isArray(supported)) {
    return [];
  }
  return supported.filter((version): version is string => typeof version === "string");
}
