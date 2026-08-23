import { isDeclaredInternalHost } from "@/domain/security/internalHosts";

/** A tool a bound MCP server offers. `inputSchema` is the JSON Schema the
 * server advertises; absent when it declares none. */
export interface McpTool {
  name: string;
  /** A human-readable name, when the server gives one beside the identifier. */
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** How a token-endpoint request proves which client it is. From AS metadata. */
export type TokenEndpointAuthMethod = "client_secret_post" | "client_secret_basic" | "none";

/**
 * What one registry entry needs to run an OAuth flow against its server,
 * discovered once at registration (RFC 9728 → RFC 8414) and stored.
 *
 * Discovery is NOT repeated at dispatch: it would put two extra round trips on
 * every time-to-first-token and a third-party outage on the critical path. The
 * values here belong to the server, never to a caller — whose credentials they
 * are is the connection's business.
 */
export interface McpServerAuth {
  type: "oauth2";
  /**
   * The RFC 9728 canonical URI of this MCP server, sent as the RFC 8707
   * `resource` parameter on every authorization and token request. Read off the
   * metadata's own `resource` field, never derived from the endpoint URL: they
   * differ in practice (Slack serves `…/mcp` but identifies as the origin).
   */
  resource: string;
  /** Which `authorization_servers` entry was chosen; the choice is the client's. */
  authorizationServer: string;
  /**
   * The `issuer` the authorization server's own metadata claims — the identity
   * a callback's RFC 9207 `iss` is compared against, and the key a connection's
   * client credentials are bound to (SEP-2352, SEP-2468).
   *
   * Required. An entry discovered before it was recorded has none and is
   * refused rather than fallen back on: the fallback was
   * {@link authorizationServer}, which is the URL we *asked at* rather than the
   * identity the server claimed, and treating the two as interchangeable is
   * exactly what the literal comparison downstream exists to prevent. Re-running
   * Discover on the entry stores the published value.
   */
  issuer: string;
  /** RFC 9207: does this server advertise that it returns `iss`? See the metadata field. */
  issParameterSupported?: boolean;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /**
   * RFC 7591. Absent means the provider requires a manually registered app.
   *
   * Deprecated by the revision that introduced metadata documents, and tried
   * once as removed — but a server on a 2025-era release advertises this and
   * nothing else, so dropping it makes a working entry unconnectable for a
   * reason its owner cannot fix. It is the last resort, behind both a stored
   * client and a metadata document.
   */
  registrationEndpoint?: string;
  /**
   * Does this server resolve a `client_id` that is an HTTPS URL by fetching the
   * document it points at? See the metadata field of the same meaning.
   *
   * Preferred over {@link registrationEndpoint} where both are offered: from
   * protocol `2026-07-28` registration is deprecated in favour of these
   * documents, and there is nothing to store or re-register.
   */
  clientIdMetadataDocumentSupported?: boolean;
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  scopesSupported?: string[];
  discoveredAt: string;
}


/**
 * How a server is reached, and therefore why its address may be trusted.
 *
 * `remote` is every entry that has ever existed: an operator typed a URL, and
 * it earns trust by passing the SSRF guard at registration and again at
 * dispatch. Absent means `remote`, so stored rows keep their meaning.
 *
 * `managed` is a container this app started on its own host. Its address is
 * loopback — which the guard rejects, correctly, for anything an operator
 * types — so trust comes from provenance instead: nobody named the address, we
 * recorded it after binding the port.
 */
export type McpRuntime = "remote" | "managed";

/**
 * A managed container's own address: loopback, recorded by the provisioner.
 *
 * Deliberately narrow. Not "managed servers are trusted" and not "private
 * addresses are allowed for managed servers", but: this entry says it is
 * managed, and the address we recorded for it is loopback. A managed entry
 * carrying anything else is a bug or tampering, and is refused like any other
 * private address would be.
 *
 * This answers "is this a container we started", which the managed lifecycle
 * asks to validate what a provisioner reported. The question of whether an entry
 * may skip the outbound guard is a different one — {@link skipsUrlGuard} owns
 * that, and this is one of its two answers.
 */
export function isManagedLoopback(server: Pick<McpServer, "runtime" | "url">): boolean {
  if (server.runtime !== "managed") {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(server.url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:") {
    return false;
  }
  // Literal addresses only: a hostname would have to be resolved, and whatever
  // it resolves to could change between the check and the request.
  return parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]" || parsed.hostname === "::1";
}

/**
 * The one place that decides an entry may skip the public-URL guard.
 *
 * Two ways in, and they are different kinds of claim. **Provenance**: this app
 * started the container and recorded the loopback address itself, so nobody
 * typed it. **Declaration**: an operator put the host's suffix in this
 * deployment's configuration, which is the only way an address the guard rejects
 * can be reached by a name someone typed.
 *
 * Everything else faces the guard, at registration and again at dispatch.
 */
export function skipsUrlGuard(
  server: Pick<McpServer, "runtime" | "url">,
  internalHostSuffixes: readonly string[] = [],
): boolean {
  return isManagedLoopback(server) || isDeclaredInternalHost(server.url, internalHostSuffixes);
}

export interface McpServer {
  name: string;
  url: string;
  /** Absent on every row written before managed servers existed: those are `remote`. */
  runtime?: McpRuntime;
  /**
   * Managed only: the image the provisioner runs. An image reference, never a
   * command — an operator who can edit this entry must not thereby be able to
   * run arbitrary code on the host.
   */
  image?: string;
  /**
   * Managed only: host env-file paths holding the container's environment.
   * References, not values: the secrets never enter this table.
   */
  envRefs?: string[];
  /** Managed only: encrypted-at-rest environment values. Masked on client reads. */
  environment?: Record<string, string>;
  /** Managed only: arguments appended to the image entrypoint. */
  args?: string[];
  /** Managed only: streamable HTTP endpoint exposed by the container. */
  endpointPath?: string;
  /**
   * Managed only: the port the container listens on inside itself. Stored so a
   * restart can rebuild the spec the entry was created from — an operator types
   * this once, and nothing else remembers it. Absent on rows written before it
   * was persisted; the provisioner falls back to the port it binds anyway.
   */
  containerPort?: number;
  /** Present when the server requires OAuth; absent for static-header servers. */
  auth?: McpServerAuth;
  /**
   * One-line summary. This is the only field the engine shows the model — it
   * becomes a row in the system prompt's "Connected MCP Servers" table
   * (`mcpSystemPromptAddition`), so it must stay single-line or the markdown
   * table breaks.
   */
  description?: string;
  /**
   * Operator notes in markdown (setup steps, caveats, links). Console-only:
   * never sent to the model, unlike a skill's content.
   */
  content?: string;
  /**
   * Provenance marker for entries created or adopted by the plugins sync,
   * e.g. `"github:opspresso/agent-plugins#devops"` — the repo and the plugin
   * that declared it. The sync stamps it on create and on adoption (a name a
   * plugin declares is the repository's, whatever origin — or none — the
   * stored entry carried), and the console's repo-owned gate reads it. Absent
   * only for an entry registered by hand whose name no plugin declares.
   */
  source?: string;
  /** Values encrypted at rest (enc:v1: prefix); masked on client reads (length-preserving; 9–20 chars reveal 2 at each end, 21+ reveal 4). */
  headers: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}
