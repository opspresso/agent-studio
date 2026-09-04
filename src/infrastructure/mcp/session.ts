/**
 * One connection to a single MCP server, over `@modelcontextprotocol/client`.
 *
 * The single owner of the protocol. Both callers use it: the engine's
 * {@link ../toolManager ToolManager} for a run's tools, and the registry's
 * "Test connection" probe. A second implementation had already drifted from
 * this one on headers, framing and timeouts.
 *
 * **This client speaks both protocol eras**, and which one a connection uses is
 * the server's answer rather than this deployment's choice. Revision
 * `2026-07-28` removed the `initialize` handshake, so every connection opens
 * with the `server/discover` probe and falls back to the handshake for a server
 * that does not recognise it. Pinning the new revision instead was tried and
 * reverted: an MCP server is somebody else's deployment on somebody else's
 * release schedule, and refusing every one that has not moved yet turns a
 * working registry entry into a broken one for a reason its owner cannot fix.
 *
 * The cost of carrying both is real and lives in this file: a legacy connection
 * mints a server-side session that has to be recovered when it expires
 * ({@link McpSession.withSessionRecovery}) and released when the run ends, and
 * neither exists on a modern one. That is the trade — a seam kept here so that
 * no registry entry has to be upgraded in step with this app.
 *
 * **Why an SDK here, when `application` may name none.** This is the adapter
 * layer, where a protocol client belongs, and the protocol stopped being small:
 * a client now has to detect which era a server implements and speak either the
 * handshake or the per-request `_meta` envelope — with `Mcp-Param-*` mirroring,
 * `server/discover` and multi round-trip results behind it. Hand-rolling that
 * over `fetch` was tractable while the protocol was one handshake and two verbs;
 * it is not now, and the era detection is the part that is easiest to get subtly
 * wrong.
 *
 * What this file keeps is everything the SDK has no opinion about, and each of
 * these was a defect once: the SSRF guard the deployment requires
 * ({@link boundedFetch}), a ceiling on what one response may pull into memory,
 * and the fact that a session connects lazily so a turn calling no tool makes
 * no request at all.
 */

import {
  Client,
  InsufficientScopeError,
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
import { version as APP_VERSION } from "../../../package.json";
export type { McpTool };
import { fetchPublicUrl } from "@/infrastructure/net/publicFetch";
import { cutCodePoints } from "@/shared/utf8Text";
import { withTimeout } from "@/shared/withTimeout";

/**
 * The revision this client probes with — the newest it can speak. Not a version
 * it insists on: the SDK adopts whatever the server turns out to speak.
 *
 * Written here rather than re-exported, because the SDK's
 * `LATEST_PROTOCOL_VERSION` names something else — the newest *legacy* revision,
 * which is what it proposes in the `initialize` handshake once the probe has
 * found a 2025-era server. Both travel, on different requests, so exporting one
 * under this name would make the other look like a bug when it appeared on the
 * wire. Kept in step with the SDK by {@link ../../../tests/toolManager.test.ts},
 * which asserts the probe actually states it.
 */
export const PROTOCOL_VERSION = "2026-07-28";

/** The revision proposed to a server that predates the probe. */
export { LATEST_PROTOCOL_VERSION as LEGACY_PROTOCOL_VERSION } from "@modelcontextprotocol/client";

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

/** How this client names itself to a server: the deployment's own version, not a frozen one. */
export const MCP_CLIENT_INFO = { name: "agent-studio", version: APP_VERSION } as const;

/**
 * What a 401 or 403 said in `WWW-Authenticate`, kept by the session that
 * received it. The SDK's errors carry the status and the body, not the
 * header, and the header is where a server names the scopes it wants
 * (`insufficient_scope`) — the one answer that turns "unreachable" into
 * "needs a wider grant".
 */
export interface McpChallenge {
  status: number;
  scope?: string;
  error?: string;
}

/** Whether a challenge is the server asking for a wider grant rather than refusing the token. */
export function isScopeChallenge(challenge: McpChallenge | undefined): challenge is McpChallenge {
  return challenge?.status === 403 && challenge.error === "insufficient_scope";
}

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
function boundedFetch(
  loopback: boolean,
  runSignal: () => AbortSignal | undefined,
): FetchLike {
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
 * The SDK forwards a caller's `signal` to the transport only on a modern
 * connection with a per-request stream; on a 2025-era server it rejects the
 * promise and leaves the POST running, holding a socket until the server answers
 * or the call deadline passes. Merging it here is what makes a cancelled run
 * actually stop talking.
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
  /**
   * Set once {@link end} starts, so teardown is not cancelled by the very signal
   * that caused it. A run aborted mid-flight still has a server-side session to
   * release, and releasing it is the one request that must outlive the run.
   */
  private tearingDown = false;
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
      fetch: boundedFetch(
        this.loopback,
        () => (this.tearingDown ? undefined : this.signal),
      ),
      // This deployment owns OAuth outside the SDK. Let the transport parse
      // the exact response's challenge and return it as a typed error; a
      // session-global "last challenge" races when one model turn calls tools
      // concurrently.
      onInsufficientScope: "throw",
      // The registry entry's own headers — a bearer token, a tenant id. Applied
      // as transport defaults so every request carries them, including the
      // era probe, which is the first request a server ever sees from us.
      requestInit: { headers: this.headers },
    });
    const client = new Client(MCP_CLIENT_INFO, {
      // Probe first, handshake if the probe is not recognised — which is what
      // lets one registry hold servers on either era. Neither of the SDK's
      // other modes will do: `'legacy'` is the default and would make this a
      // 2025-era client without a word, and `{ pin }` refuses every server that
      // has not moved yet.
      versionNegotiation: { mode: "auto" },
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
   * Run one request, retried once behind a fresh connection if the server says
   * the session is gone.
   *
   * The SDK does not do this, and a legacy server's session outliving neither
   * the run nor its own TTL is not hypothetical: runs here last up to ten
   * minutes. Streamable HTTP answers a request carrying an unknown
   * `Mcp-Session-Id` with 404 and requires the client to start a new session
   * rather than treat it as a dead server — without the retry, a run that
   * crosses that boundary loses every tool for the rest of the run, the model
   * keeps calling, and every call reads `HTTP 404` with no path back.
   *
   * Retrying is safe precisely because the 404 is a session-lookup failure: the
   * server rejected the message before running anything, so a `tools/call` that
   * gets one had no effect to repeat. Bounded at one attempt, because a server
   * answering 404 to everything — the endpoint itself is gone — would otherwise
   * be reconnected to forever, and the second failure is the one that says so.
   *
   * Protocol `2026-07-28` has no sessions at all, so on a modern connection
   * `sessionId` is undefined and this is exactly one attempt.
   */
  private async withSessionRecovery<T>(
    method: string,
    work: (client: Client) => Promise<T>,
  ): Promise<T> {
    const client = await this.ensureConnected();
    // Captured before the attempt: it is what decides whether a 404 means *this*
    // session expired, and whether another caller has already replaced it.
    const attemptedSession = this.transport?.sessionId;
    try {
      return await work(client);
    } catch (error) {
      const failure = asMcpError(error, method);
      if (
        !(failure instanceof McpHttpError) ||
        failure.status !== 404 ||
        // No session id means the 404 is about the endpoint, not a session.
        attemptedSession === undefined
      ) {
        throw failure;
      }
      // Only the caller whose session is still the current one discards it. The
      // MCP calls of one model response are dispatched concurrently, so several
      // can hold the same expired id — and each reconnecting in turn would
      // abandon a connection another had already started, minting one
      // server-side session per caller and leaking all but the last. The rest
      // simply wait on the connection the winner started.
      if (this.transport?.sessionId === attemptedSession) {
        await this.discard();
      }
      try {
        return await work(await this.ensureConnected());
      } catch (retryError) {
        throw asMcpError(retryError, method);
      }
    }
  }

  /** Drop the dead connection so the next caller opens a fresh one. */
  private async discard(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.transport = undefined;
    this.connecting = undefined;
    // No session release: the server has already forgotten it, which is what
    // the 404 said.
    await client?.close().catch(() => {});
  }

  /**
   * Every page of the server's catalogue, not just the first — the SDK walks the
   * `nextCursor` chain, bounded by {@link MAX_TOOL_PAGES}.
   *
   * The freshness a paged catalogue comes back with is the **first page's**. The
   * per-page call that would let us see the rest is unreachable — the SDK's
   * per-page path is selected by passing a cursor, and the first page has none —
   * so a server whose later pages ask for a shorter life is cached for longer
   * than it asked. Bounded rather than unbounded: `MCP_MAX_SERVER_TTL_MS` caps
   * whatever a server asks for, and a catalogue whose pages disagree about their
   * own lifetime is not a shape any server here produces.
   */
  async listTools(): Promise<McpDiscovery> {
    const result = await this.withSessionRecovery("tools/list", (client) =>
      client.listTools(undefined, this.requestOptions(MCP_DISCOVERY_TIMEOUT_MS)),
    );
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
    return this.withSessionRecovery("tools/call", (client) =>
      client.callTool(
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
      ),
    );
  }

  /**
   * Release the server-side session and close the connection. Best-effort:
   * servers may not implement the release, protocol `2026-07-28` has no session
   * to release at all, and a run must never fail on cleanup. A session that
   * never connected has nothing to close and returns at once.
   */
  async end(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.client = undefined;
    this.transport = undefined;
    this.connecting = undefined;
    this.tearingDown = true;
    if (!transport) {
      return;
    }
    try {
      // `close()` does not send it; on a legacy connection the DELETE is what
      // frees the server's session, and without it each run leaks one. Protocol
      // `2026-07-28` mints no session, so there is nothing to release and this
      // is skipped.
      if (transport.sessionId) {
        await withTimeout(transport.terminateSession(), SESSION_END_TIMEOUT_MS);
      }
    } catch {
      // Session teardown is best-effort.
    }
    try {
      // Whichever end got as far as existing: a connect that threw leaves the
      // transport open with no client above it.
      await withTimeout(client ? client.close() : transport.close(), SESSION_END_TIMEOUT_MS);
    } catch {
      // Closing is best-effort too: the run is already over.
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
    /** The authentication challenge from this request, never another concurrent call's. */
    readonly challenge?: McpChallenge,
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
  if (error instanceof InsufficientScopeError) {
    const challenge: McpChallenge = {
      status: 403,
      error: "insufficient_scope",
      ...(error.requiredScope ? { scope: error.requiredScope } : {}),
    };
    return new McpHttpError(403, method, boundedFailure(method, 403, error.message), challenge);
  }
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
 * unconnected, and the registry's probe — so they share this predicate.
 */
export function isUnauthorized(error: unknown): boolean {
  return error instanceof McpHttpError && error.status === 401;
}

/** The wider OAuth grant this exact failed request asked for, if it did. */
export function scopeChallengeOf(error: unknown): McpChallenge | undefined {
  return error instanceof McpHttpError && isScopeChallenge(error.challenge) ? error.challenge : undefined;
}

/**
 * Is this server answering, but in a way this client cannot use?
 *
 * The distinction the caller needs, because "unreachable" sends an operator to
 * check a host that is up and replying. Three failures are of this kind, and
 * none of them is fixed by looking at the network:
 *
 * - a server supporting only revisions newer than this client, which answers
 *   `-32022` naming what it does speak. The probe cannot rescue this one — the
 *   era gap it *can* cross is the older direction.
 * - a server whose reply breaks the schema. The client validates a whole
 *   result, so one tool with a non-object `inputSchema` costs that server its
 *   entire catalogue. Strictly a behaviour change from the hand-rolled client,
 *   which read what it could and dropped the rest; the trade is that a
 *   malformed answer is now named instead of silently thinned.
 * - a catalogue that does not finish inside {@link MAX_TOOL_PAGES}. The SDK
 *   throws on the cap rather than returning the pages it walked, so the whole
 *   catalogue is lost and the server is not at fault in a way pinging it shows.
 *
 * A 2025-era server is deliberately **not** one of them: the probe falls back to
 * the handshake, so it is an ordinary working server rather than one this client
 * cannot use.
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
