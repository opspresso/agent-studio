# MCP

The registry entry, the session that owns the protocol, what a run tells a server about
itself, and the three things that keep an entry reachable: a discovery cache, managed
containers on loopback, and per-project OAuth.

The security half — the SSRF guard, the loopback exception, every OAuth check, and what a
server may learn about the caller — is [SECURITY.md](../SECURITY.md#mcp-oauth). The knobs
are [CONFIGURATION.md](../CONFIGURATION.md#mcp).

```ts
McpServer { name, url, description?, content?, source?, runtime?: 'remote' | 'managed',
            headers: Record<string, string>,   // encrypted at rest, masked on read
            auth?,
            // managed only; `environment` is encrypted at rest like `headers`
            image?, args?, endpointPath?, containerPort?, environment?, envRefs?,
            createdAt, updatedAt }
```

`description` is a one-line summary and **the only field the model sees** — it becomes a row
in the system prompt's server table. `content` is markdown operator notes shown in the console
only; unlike a skill's content it never reaches the model. Descriptions are escaped when
rendered into the table, so a legacy multi-line value cannot break it.

Registry entries also arrive through the plugins sync: a plugin's `mcp.json` declares its
servers, and only `type: "streamable-http"` entries are bound — `stdio` would mean executing
a repository-supplied command on the host, so it is reported and skipped, never run
(`classifyMcpJsonServer` in `src/domain/plugin/types.ts` is the one transport decision). The
closed mcp.json schema has no description field, so each server's model-facing description
and operator notes ride in the plugin's `org.opspresso.agentdure/mcp/<server>.md`
extension document — the reverse-domain client-extension convention the spec defines. The
stakes are higher here than for skills: an entry also holds encrypted headers and a
discovered OAuth block, so headers declared in mcp.json are never imported (the dropped
names are reported), even a caller-named overwrite replaces only the document-owned fields,
and each URL faces the same outbound guard a typed one does — a refusal is a skip, not a
failed sync.

Agent runs append a **"Connected MCP Servers"** table (server name, description, aliased tool
names) to the system prompt so the model knows which server a tool group belongs to; servers
that are unreachable or expose no tools are omitted.

**Every request a run makes names its calling project**, as `X-Tenant-Id` (`TENANT_ID_HEADER`
in `src/application/execution/mcpTools.ts`), so a multi-tenant server scopes its data per
project with no per-project registration. It is stamped **after** the header merge — so
neither the registry entry nor a version's overrides can spoof another project's tenant, in
any spelling — and **after** the OAuth-availability check, so metadata never counts as a way
to authenticate a server whose connection is unavailable. A caller with no project behind it
sends none: the catalog probe and "Test connection" carry no tenant. Because it rides in the
same header map, it also keys the [discovery cache](#discovery-cache) per project, so a server
free to expose different tools per tenant is cached per tenant. **And names its conversation**,
as `X-Conversation-Id` (`CONVERSATION_ID_HEADER`, same file) carrying the run's
`conversationKey` when it has one — the header a memory server needs to tell one thread's
working notes from the project's shared knowledge. Reserved and stamped after the merge like
the tenant, but carried in the session's *context* headers rather than its identity headers
(`McpServerConfig.contextHeaders`), so it reaches every request and **never the discovery
cache key**: a conversation decides nothing about which tools a server exposes, and keying on
it would pay a full discovery per thread for a catalogue that has not changed. The full
contract is in [SECURITY.md](../SECURITY.md#what-an-mcp-server-is-told-about-the-caller).

## Transport and sessions

Tool loading uses MCP streamable HTTP (`tools/list`, `tools/call` JSON-RPC). The protocol has
**one owner**, `McpSession` (`src/infrastructure/mcp/session.ts`) — both the engine's
`ToolManager` and the registry's "Test connection" probe run on it.

The session is an adapter over **`@modelcontextprotocol/client`**, and the reason is the
`2026-07-28` revision: it removed the `initialize` handshake, so a client must now detect
which era a server implements and speak either the handshake or a per-request `_meta`
envelope. Every connection opens with **`server/discover`**; a server that answers it is
talked to statelessly, and one that answers `-32601` gets the `initialize` handshake instead.
A server supporting only revisions this client does not know answers `-32022` naming what it
does speak, which `unusableServerReason` reports as *this client needs upgrading* rather than
as an unreachable host.

**Pinning the revision instead was tried and reverted.** It is cheaper — a handshake, a
session id and the expiry recovery around it all disappear, and with them the seams a
dual-era client can be quietly wrong in. What it costs is every server that has not moved
yet, and an MCP server is somebody else's deployment on somebody else's release schedule: a
registry entry that stops working because this app upgraded is a failure its owner cannot
fix. The seam is kept here so that no entry has to be upgraded in step.

The SDK is an adapter-layer dependency, which is where a protocol client belongs; the rules
in [AGENTS.md](../../AGENTS.md#the-dependency-rule) keep it out of `application` and `domain`.
What the SDK has no opinion about stays in the session, and each of these was a defect once:
the SSRF guard (injected as the transport's `fetch`, so an operator-supplied MCP URL still
cannot name the metadata service), a ceiling on what one response may pull into memory, the
lazy connect below, and the expired-session retry — which the SDK does not implement.

- Tool-name collisions get `_1`/`_2` suffix aliases with a reverse mapping, and the same
  aliasing carries a name a **provider** would refuse: MCP allows 128 characters and a dot
  (`admin.tools.list` is the spec's own example) where a function name is
  `[A-Za-z0-9_-]{1,64}`. The name is normalised into one instead of the tool being dropped,
  silently, like a collision alias — the server is still called by the name it published.
  Only a name with nothing to build an alias out of is refused. Tool results are capped at
  100,000 chars.
- Servers are contacted **in parallel** at init (one unreachable server would otherwise add
  its full timeout to time-to-first-token) while alias allocation stays in configured order,
  so names are deterministic.
- Sessions are registered before their first request and released with a `DELETE` when the run
  ends (`ToolManager.close()`, called from the execution facade's `finally` — including when
  discovery itself failed or was cancelled).
- A request answered **`404` while carrying an `Mcp-Session-Id`** means the server has
  forgotten that session and the transport requires a new one: the connection is dropped and
  the request is replayed **once** behind a fresh one. Replaying is safe because a 404 is a
  session-lookup failure — the server rejected the message before running anything, so a
  `tools/call` that gets one had no effect to repeat. Bounded at one attempt, or an endpoint
  that has genuinely gone would be reconnected to forever. **Only the caller whose session is
  still the current one discards it**: one model response dispatches its MCP calls together, so
  several can hold the same dead id, and each resetting in turn would abandon a connection
  another had started and mint one server-side session per caller. Without this, a run that
  outlives the server's session TTL — runs here last up to ten minutes — loses every remaining
  tool call, with the model reading `HTTP 404` and no path back. This is the session's own
  code: the SDK has no such recovery. Protocol `2026-07-28` mints no session at all, so on a
  modern connection the retry is unreachable by construction, and teardown sends no `DELETE`.
- After the handshake, requests state the protocol version the **server** agreed to rather
  than the one proposed. The handshake itself proposes in its *body*: the header names the
  revision in use, and until the server answers there is not one. The era probe ahead of it
  carries the newest revision this client speaks, which is what it is asking about.
- On a `2026-07-28` connection every POST mirrors its body into **`Mcp-Method`**, a request
  naming something into **`Mcp-Name`**, and a parameter the tool marks `x-mcp-header` into
  `Mcp-Param-*` (SEP-2243), so a gateway or rate limiter can route and meter without parsing
  the body. A name outside printable ASCII travels Base64-encoded (`=?base64?…?=`). **None of
  them appear on a 2025-era exchange**, and that is deliberate rather than an omission: the
  spec tells an intermediary to reject mirrored values it cannot check against a version that
  guarantees the server validated them, so sending them to a server that never promised that
  validation is worse than not sending them. The SDK owns the mirroring, including excluding
  a tool whose `x-mcp-header` declaration breaks the constraints rather than letting one
  malformed tool cost the rest. **The tool's definition is handed to the call**, because the
  SDK derives `Mcp-Param-*` from the `inputSchema` of a `tools/list` it sent itself — and a
  warm discovery cache means it often sent none. Without that, a run on a cached catalogue
  would omit a header whose value is in the body, which a server routing on it must reject.
- A result marked **`resultType: "input_required"`** — the server needs an approval or a
  missing argument before it can answer (MRTR, protocol `2026-07-28`) — is reported as its own
  failure rather than falling through the "no content" check, which would send an operator to
  look at a server behaving exactly as its protocol says it should. This client does not answer
  those requests. A result omitting the field is an ordinary one, as the spec requires.
- A tool's **image** results (`image` blocks, and `resource` blobs with an image mime type)
  come back as bytes rather than being dropped: the engine registers them and streams them to
  the user, and attaches them to the turn as a follow-up user message — that last step only
  when the model accepts image input, since a text-only model would reject the parts and fail
  the turn. Delivery does not depend on the model: the person who asked for the screenshot is
  not the model, and the result text says the picture went to them and not into the
  conversation.
- **Every other content type is read as the protocol defines it.** A `resource_link` becomes
  its URI plus whatever identifies it — it is a pointer the model can ask for, not a payload.
  An `audio` block is named and stops there, because a turn carries only text and images, so
  the model is told a recording exists and can ask for a transcript.
- **A result that breaks the schema is refused whole.** The client validates the entire
  result, so one tool declaring a non-object `inputSchema` costs that server its whole
  catalogue, and a content block of a type the schema does not know fails that call. This is a
  change from the hand-rolled client, which read what parsed and named the rest — the trade is
  that a malformed answer is reported instead of silently thinned, and a revision that adds a
  block type will need an SDK upgrade. It is kept out of "unreachable"
  (`unusableServerReason`), because the server is up and answering and the fix is on one side
  or the other, never on the network.
- **A server that does not declare the `tools` capability is never asked for its catalogue.**
  The spec requires the declaration of any server that has tools, and the SDK returns an empty
  list without sending `tools/list`. That would be a silent loss, so the run says which of the
  two happened: `McpSession.declaresTools` is what the emptiness warning reads.
- **A catalogue that never finishes paging costs all of it.** The aggregating walk throws at
  the page cap and keeps no partial result, where the hand-rolled one returned the pages it
  had and warned about the tail — so the cap is no longer free, sits at the SDK's own default
  of 64 rather than below it, and reaching it is reported as a server this client cannot use.
  The discovery deadline is the real defence against a cursor that never converges.
- **`structuredContent` is read when the server sent no content blocks.** Serializing it into
  a text block is only a SHOULD, so a server that skips it is still answering — that result
  used to be reported as "no content", a failure report about a call that succeeded. Content
  blocks win when both are present, since the text block is the serialization. An `isError`
  result with nothing to explain it keeps the **verdict** rather than reporting the emptiness;
  an empty `content` array is a call that succeeded with nothing to say (a delete that
  removed something), not a failure, and no longer reaches the model as the string `[]`.
- A **401 from a tool call** flags the connection for reconnection exactly as one from
  discovery does, and it has to: discovery is cached, so a run with a warm cache makes its
  first request to that server *at the first tool call*, and a token revoked since the last
  discovery can surface nowhere else. Recorded once per server however many calls it rejects,
  and applied when the run releases its sessions. Every tool failure also names the tool and
  the server — a run may bind several, and a bare `HTTP 500` points at none of them.

## Discovery cache

Discovery is cached per `url + headers` (`discoveryCache.ts`). On a hit the session is left
unconnected and connects lazily on its first tool call, so **a turn that calls no tool makes
no MCP request at all** — a chat used to pay the full handshake per message per server.
Headers are part of the key so one tenant's tool list never answers another's.

Failures are cached too, briefly, and as one value (`DiscoveryFailure`) so a replayed failure
explains itself exactly as the live one did — including the two readings that are not
"unreachable": a 401 asks the *project* to reconnect, and an unusable server asks for a fix on
one side or the other.

A server that sends the caching hint `ttlMs` on `tools/list` (SEP-2549) sets its own entry's
lifetime — it knows its catalogue, and the local default is only a guess about someone else's
— bounded by a separate ceiling. For a **paged** catalogue that hint is the first page's,
where this client used to take the shortest across pages: the SDK's per-page call is selected
by passing a cursor, which the first page does not have. The full reasoning for two knobs, and
their values, is in [CONFIGURATION.md](../CONFIGURATION.md#mcp).

## Managed servers

`runtime: "managed"` is a container **this app starts on its own host** through SSM Run
Command, reached at `127.0.0.1:<port>`. That address is one the URL policy rejects —
correctly, for anything an operator types — so trust rests on **provenance** instead: the
provisioner recorded the address after binding the port. The narrowness of that bypass is a
security property; see
[SECURITY.md](../SECURITY.md#the-managed-loopback-exception).

The stored row carries `image`, `args`, `endpointPath`, `containerPort` and the container's
environment — everything a restart needs, because at restart time there is no operator to ask
again. The environment arrives two ways on purpose: `envRefs` names SSM parameters, so those
values never enter this table at all, while `environment` holds the ones that had nowhere else
to live and is encrypted at rest like every other stored credential. `PORT` is refused in it,
because the runtime owns that.

`containerPort` is a *request*, not a guarantee: only an adapter that publishes a port mapping
can honour it, and the deployed one shares a network namespace instead, so it tells the
container which port to bind (`PORT`) and ignores the stored value. `{{PORT}}` in an argument
becomes the effective listen port, so images that do not honour the `PORT` environment
variable still work in both mapped-port and shared-network deployments.

**Surviving a redeploy.** A managed container joins this app's own network namespace, which is
the only way a loopback address means the same thing at both ends. Docker resolves that
container name to an **id** when the workload starts and never re-resolves it, so replacing
this app leaves the container running in a namespace nothing can address — healthy to
`docker inspect`, reachable by nobody. `reconcile` (`src/application/mcp/managedMcpUseCases.ts`),
fired from `instrumentation.ts` at boot and never awaited, probes every managed entry and
restarts the ones that do not answer. `status` reports **reachability separately from
liveness** for the same reason: reporting only the latter is what made this invisible. Sharing
a namespace also means **one app instance per host** — a container belongs to exactly one.

## OAuth

A registry entry may carry an `auth` block discovered once at registration; **the run path
never fetches a well-known document.**

The placement decision is the architectural one: credentials are **per project**, in their own
`PROJECT#<name> / MCPCONN#<server>` item — not on the version (a snapshot of configuration
history) and not on the project item (whose `updatedAt` is the optimistic-concurrency
condition for publish). That split is what lets one shared registry entry serve a different
provider app per project, and it is why the registry is admin-owned while connections are
owner-owned.

A connection **supplies** credentials rather than gating the server. The resolved token is the
last **credential** applied at dispatch — over the registry entry's headers and the binding's
overrides — so a version cannot substitute its own `Authorization` for the project's
connection. (`X-Tenant-Id` is stamped after it, but it authenticates nothing.) When no
connection is available the server still runs on whatever those headers hold; it is dropped
with a warning only when they hold nothing. Discovering OAuth on an entry adds a way to
authenticate it and must not take away one an operator already configured, so a single entry
can serve a static-header project and an OAuth project side by side.

Token refresh happens only within a margin derived from `MAX_RUN_DURATION_MS`, so a token
cannot expire mid-run *and* the header stays byte-identical between runs — refreshing every
run would change the discovery cache key every run.

**Where the client itself comes from** changed with protocol `2026-07-28`, which deprecates
dynamic registration in favour of **Client ID Metadata Documents**: the `client_id` is an
HTTPS URL the client hosts, and the authorization server fetches it. Registration stays behind
it for the servers that offer nothing else — a 2025-era authorization server advertises a
`registration_endpoint` and no document support, and refusing those would leave their owners
registering an app by hand for a connection that used to work. This deployment publishes
one per project (`/api/mcps/oauth/client-metadata/{project}`) rather than one for the
deployment, because that document is what a person sees when approving the connection — a
single one would ask them to grant access to "AgentDure" with no way to tell which project is
asking, where registration named the project in every client it created. Nothing is requested
and nothing is stored: the flow that used to register, receive a secret and encrypt it now
writes a URL it already knew.

The protocol-level checks (PKCE, `resource`, `iss`, issuer binding — which inverts for a
metadata-document client) are in [SECURITY.md](../SECURITY.md#mcp-oauth).

