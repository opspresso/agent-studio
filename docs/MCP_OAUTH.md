# Work order — OAuth 2.0 for registry MCP servers

A self-contained brief for implementing per-project OAuth against a shared MCP server
entry. Read it top to bottom before writing code; it carries the decisions that must not be
re-litigated and the two traps that will silently break the feature if ignored.

Delete this file once the feature ships — `docs/ARCHITECTURE.md` is where the resulting
behaviour belongs.

---

## Goal

**A project owner can connect their own credentials to a shared registry entry for any MCP
server that implements the MCP authorization spec, and every run of that project reaches
that server as that project.**

Slack (`mcp.slack.com`) is the first server to support, not the definition of the feature.
Anything built only for Slack's particular choices — a pre-registered confidential client,
a single authorization server — is a defect, not a simplification. See
[Conformance target](#conformance-target) for the line to hold.

Exit condition, verifiable without a browser:

1. `pnpm typecheck` clean, `pnpm test` green, `pnpm build` succeeds.
2. `pnpm tsx --env-file=.env.local scripts/integration-check.ts` green, covering a
   round-trip of the new connection item.
3. A test proves a run whose project has no connection to an OAuth-required server emits a
   `warning` chunk and offers none of that server's tools — and does **not** fail.
4. A test proves two concurrent refreshes leave exactly one valid token and no broken
   connection.

Anything you cannot verify, say so in the final report with the residual risk. Do not
report a step done because the code looks right.

---

## Situation

`mcp.slack.com/mcp` speaks the exact transport `McpSession` already implements. Verified
empirically — our own client reaches it and gets a clean auth challenge:

```
SSRF guard: ALLOWED
raw initialize: HTTP 401
  www-authenticate: Bearer resource_metadata="https://mcp.slack.com/.well-known/oauth-protected-resource"
  body: {"jsonrpc":"2.0","id":null,"error":{"code":-32001,"message":"missing_token"}}
```

`bearer_methods_supported` includes `header`, so the only missing piece is a token. The
registry can already carry static headers; what it cannot do is *obtain* one, and it has
nowhere to put a credential that differs per project.

Slack's endpoints, for the fixture data you will need. Treat every value in this table as
*one server's answer*, never as the shape to hard-code:

| | Slack | Varies because |
|---|---|---|
| Resource | `https://mcp.slack.com` | RFC 9728 `resource`; the canonical URI to send as `resource` |
| Authorization | `https://slack.com/oauth/v2_user/authorize` | from AS metadata |
| Token | `https://slack.com/api/oauth.v2.user.access` | from AS metadata |
| Grants | `authorization_code`, `refresh_token` | some servers omit refresh |
| Client auth | `client_secret_post` | others use `client_secret_basic` or `none` (public client) |
| Registration | *(none — manual app)* | most hosted servers offer DCR at `registration_endpoint` |
| PKCE | `S256` | required everywhere |

---

## Conformance target

The MCP authorization spec (2025-06-18) is the contract. These are the client-side
**MUST**s; a build that skips any of them works against Slack today and breaks on the next
server.

1. **RFC 8707 `resource` in *both* authorization and token requests.** "MCP clients MUST
   send this parameter regardless of whether authorization servers support it." It binds
   the token to one MCP server; a server that validates audience rejects tokens without it.
   Use the canonical URI from the resource metadata — no fragment, no trailing slash.
2. **RFC 9728 protected-resource metadata for authorization-server discovery**, and
   **RFC 8414 AS metadata** for the endpoints. Never guess endpoint paths.
3. **Parse `WWW-Authenticate` on 401** and act on it. A 401 is "this connection needs
   authorization", which is a different thing from "this server is down" — see D7.
4. **PKCE S256** on every authorization.
5. `Authorization: Bearer` header on **every** request, never in a query string.
6. All authorization-server endpoints over HTTPS; redirect URIs HTTPS or localhost.

And one **SHOULD** that decides how many servers you can actually reach:

7. **Dynamic Client Registration (RFC 7591).** Slack has no `registration_endpoint`, so its
   credentials are entered by hand — but most hosted MCP servers expect DCR and offer no
   way to pre-register. Support both paths (D6).

---

## Repository ground rules

Read these first: `CLAUDE.md`, `docs/ARCHITECTURE.md`, `src/application/llm/AGENTS.md`.

```bash
pnpm typecheck        # tsc --noEmit, strict + noUncheckedIndexedAccess
pnpm test             # vitest run
pnpm build            # validates route handlers + instrumentation
pnpm exec vitest run tests/<file>.test.ts
```

There is **no lint step**; `typecheck` + `test` are the checks.

- Dependency rule: `app → application → domain ← infrastructure`. `src/lib` is
  cross-cutting glue; `src/shared` imports nothing from `@/`. `tests/architecture.test.ts`
  enforces this mechanically with empty allowlists — fix the import, never widen the rule.
- Route handlers get repositories and `executionDeps` from the wiring sites
  (`src/lib/container.ts`, `src/app/api/chats/_deps.ts`). Never import `infrastructure/`
  from a route; application code must never import `container.ts`.
- Every DynamoDB key string comes from `src/infrastructure/db/keys.ts`. List queries
  paginate through `queryAll()` (`src/infrastructure/db/query.ts`).
- Tests mock at boundaries: `fetch` via `vi.stubGlobal`, the doc client via
  `vi.mock("@/infrastructure/db/client")`. No real `Date.now`, timers, randomness, or
  network inside vitest — repository integration lives in `scripts/integration-check.ts`.
- Match the surrounding comment style: comments say *why*, and record the failure a line
  prevents rather than restating the code.

---

## Decisions that are already made

Implement these as written. Each exists because the alternatives are broken, not because
they read better.

### D1 — The credential lives on a new per-project item, not on the version and not on the project

`McpBinding.headers` (per version) is the wrong home: a version is a snapshot of
configuration history, while an access token changes every 12 hours, and every version of
the project would need its own copy.

`Project.slack` is the tempting precedent — per-project credentials already live there —
but the project item carries `updatedAt`, which `projects.publish` and `projects.update`
use for optimistic concurrency. Rewriting that item on every token refresh would make
refreshes and publishes fight each other.

So: a separate item, one per `(project, server)`.

### D2 — The registry entry owns the OAuth endpoints; the connection owns the credentials

The registry stays shared and admin-managed: it knows *where* the authorization server is.
The connection is owner-managed and per project: it knows *who* is asking. This is what
"shared server, per-project Slack app" decomposes into.

Endpoints are discovered **once, at registration**, and stored. The run path must never
fetch `.well-known` documents — that would put two extra round trips on every
time-to-first-token and a third-party outage on the critical path.

### D3 — A missing or broken connection degrades the run, never fails it

Reuse the existing path: a server that cannot contribute tools is skipped and reported
through `warnings`, exactly as an unreachable or deregistered server already is
(`src/application/execution/mcpTools.ts`). A project that has not connected Slack must
still be able to answer everything else.

### D4 — OAuth's `Authorization` wins over a binding header of the same name

A version must not be able to substitute its own `Authorization` for the project's
connection. For a server with `auth.type === "oauth2"`, apply the binding overrides first
and the OAuth header last.

### D5 — One connection per `(project, server)`

Two Slack workspaces on one project is out of scope. If it is ever needed, the key grows a
label and `McpBinding` has to name which one it wants — do not pre-build that.

### D6 — Client credentials always live on the connection, entered *or* DCR-issued

Two ways a client id reaches us, one place it is stored:

- **Manual** — the owner registers an app with the provider and pastes `client_id` /
  `client_secret`. Required for Slack, which has no `registration_endpoint`.
- **DCR** — when AS metadata advertises `registration_endpoint` and the connection has no
  `client_id`, `beginAuthorization` registers one and stores what comes back.

Registering per connection rather than once per registry entry costs an extra DCR call per
project and buys uniformity: one storage shape, one revocation story, and per-project
isolation that holds whether or not the provider has a per-project app concept. It also
means D1's reasoning covers DCR credentials unchanged.

A DCR-issued client may be **public** (`token_endpoint_auth_method: "none"`, no secret).
Store `clientSecret` as optional and select the token-endpoint auth method from AS
metadata — do not assume `client_secret_post`.

### D7 — A 401 at dispatch means "reconnect", not "unreachable"

`ToolManager` currently turns any discovery failure into `MCP server 'x' is unreachable`.
For an OAuth server that is the wrong diagnosis and the wrong instruction: the owner needs
"reconnect", not "check the server". Detect the 401, mark the connection `needs_reauth`,
and warn with that word. This is also what makes the spec's "parse `WWW-Authenticate`"
requirement observable.

Do **not** attempt a refresh-and-retry inside the run; T2's margin already makes mid-run
expiry unreachable, and a 401 that survives the margin means the grant is gone.

---

## Data model

```ts
// src/domain/mcp/types.ts — extend the registry entry
McpServer.auth?: {
  type: "oauth2";
  /**
   * RFC 9728 canonical URI of THIS MCP server, sent as the RFC 8707 `resource`
   * parameter. Comes from the protected-resource metadata's own `resource`
   * field — it is not always the MCP endpoint URL (Slack's endpoint is
   * `https://mcp.slack.com/mcp`, its resource is `https://mcp.slack.com`).
   */
  resource: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** RFC 7591. Absent means the provider requires a manually registered app. */
  registrationEndpoint?: string;
  /** From AS metadata; pick one we support rather than assuming post. */
  tokenEndpointAuthMethod: "client_secret_post" | "client_secret_basic" | "none";
  scopesSupported?: string[];
  /** Which AS was chosen when the resource advertised more than one. */
  authorizationServer: string;
  /** When discovery last populated this. Runtime never re-fetches. */
  discoveredAt: string;
};

// src/domain/mcp/connection.ts — new
// PK: PROJECT#<projectName>   SK: MCPCONN#<serverName>
interface McpConnection {
  projectName: string;
  serverName: string;
  clientId: string;            // not a secret, stored plain
  /** Absent for a public client (`token_endpoint_auth_method: "none"`). */
  clientSecret?: string;       // enc:v1:
  /** True when DCR issued the credentials above, so re-registration is possible. */
  clientRegistered?: boolean;
  scopes: string[];
  accessToken?: string;        // enc:v1:
  refreshToken?: string;       // enc:v1:
  /** ISO. Absent means a non-expiring token. */
  expiresAt?: string;
  status: "needs_auth" | "connected" | "needs_reauth";
  connectedBy?: string;        // email of the owner who authorized
  connectedAt?: string;
  updatedAt: string;
}

// In-flight authorization, TTL 10 minutes
// PK: MCPOAUTH#<state>   SK: META
interface McpOAuthState {
  state: string;
  projectName: string;
  serverName: string;
  codeVerifier: string;        // enc:v1:
  userEmail: string;
  createdAt: string;
  ttl: number;                 // unix seconds
}
```

`src/infrastructure/db/ttl.ts` only offers day-granularity (`expiresAtSeconds(baseIso,
retentionDays)`). Add a seconds-scale helper there rather than computing a TTL inline —
TTL math has one owner in this codebase and it should stay that way.

---

## Ports and placement

```
domain/mcp/connection.ts          McpConnection + McpConnectionRepository port
domain/mcp/oauth.ts               OAuthClient port: exchangeCode(), refresh()
                                  McpAuthProvider port: headersFor(project, server)
application/mcp/mcpAuthUseCases.ts
                                  createMcpAuthProvider(connections, oauth, cipher)
                                  beginAuthorization / completeAuthorization / disconnect
infrastructure/db/repositories/mcpConnectionRepository.ts
infrastructure/db/repositories/mcpOAuthStateRepository.ts
infrastructure/mcp/oauthClient.ts    over fetchPublicUrl
```

`ExecutionDeps` gains exactly one field: `mcpAuth: McpAuthProvider`. Expiry judgement and
the conditional refresh are application logic; only the token HTTP call is infrastructure.
This mirrors how `createSettingsUseCases` is split, and it keeps `buildMcpTools` from
learning anything about OAuth beyond "ask for headers".

---

## The two traps

### T1 — Refresh-token rotation is a race with a permanent loser

Slack revokes the previous refresh token when it issues a new one. Two instances
refreshing the same connection concurrently means one succeeds and the other gets
`invalid_grant` — and if the loser then writes its failure, **the connection is
permanently broken and the owner must re-authorize.**

Guard it with a conditional write on the value being replaced:

```
ConditionExpression: refreshToken = :expectedRefreshToken
```

On `isConditionalWriteFailure` (`src/application/errors.ts`), re-read the item and use the
winner's token instead of surfacing an error. `slackEventRepository.claim` and
`projects.publish` are the patterns to copy.

A failed exchange must only set `status: "needs_reauth"` when the token endpoint says the
grant itself is invalid — never on a network error or a 5xx, which are transient.

### T2 — Refreshing unconditionally at run start destroys the discovery cache

`src/infrastructure/mcp/discoveryCache.ts` keys entries on `url + headers`, so a token that
changes on every run changes the cache key on every run, and discovery never hits. Every
message would then pay a full `initialize` + `tools/list` before its first token.

**Refresh only when expiry is near.** Derive the margin from the run deadline so a token
cannot expire mid-run, the way `RUN_LEASE_SECONDS` is derived in
`src/shared/runDeadline.ts`:

```ts
// A run is bounded by MAX_RUN_DURATION_MS, so a token valid for longer than that
// (plus slack) at resolve time cannot expire while the run is still using it.
const REFRESH_MARGIN_MS = MAX_RUN_DURATION_MS + 5 * 60_000;
```

With a 12-hour Slack token this leaves the header byte-identical across runs for ~11.75
hours, and the cache works as designed.

---

## Phases

Each phase ends green. Do not start the next one with the suite red.

### P1 — Model and storage

Add the `auth` field to `McpServer`, both repositories, both key builders in `keys.ts`, the
seconds-scale TTL helper, and the container wiring.

→ **Verify:** a round-trip of `McpConnection` and `McpOAuthState` added to
`scripts/integration-check.ts` and passing against local DynamoDB; `pnpm test` green
(`tests/architecture.test.ts` will fail loudly if a layer was crossed).

### P2 — Discovery at registration

An admin-only action on the registry entry that reads
`/.well-known/oauth-protected-resource` then `/.well-known/oauth-authorization-server`,
validates both URLs through `urlPolicy`, and stores the `auth` block. It must capture the
metadata's own `resource`, the chosen `authorization_servers` entry, the
`registration_endpoint` when present, and a `token_endpoint_auth_method` we support.
Manual entry stays possible for servers that publish neither document.

Where `authorization_servers` holds more than one, the choice is the client's (RFC 9728
§7.6): surface them and let the admin pick, storing which was chosen. Never silently take
`[0]`.

→ **Verify:** unit tests with `vi.stubGlobal("fetch", …)` for three metadata shapes —
Slack's real one (no `registration_endpoint`, `client_secret_post`), one advertising DCR
with `"none"` auth, and one with two `authorization_servers`. Assert the stored block for
each, that `resource` comes from the metadata rather than the endpoint URL, and that a
blocked URL is rejected as a `ValidationError` and not stored.

### P3 — Authorization flow

`POST …/mcp-connections/[server]` (owner) saves manually-entered client credentials.
`POST …/mcp-connections/[server]/authorize` (owner) registers a client via DCR when the
server offers one and none is stored (D6), then mints `state` + PKCE verifier, persists
them with TTL, and returns the authorization URL — carrying `resource`, `scope`,
`code_challenge`, `state`, and `redirect_uri`.
`GET /api/mcps/oauth/callback` (`withAuth`) consumes `state` **once** via a conditional
delete, re-checks that the session user is `state.userEmail` and is *still* the project
owner, exchanges the code — with `resource` and `code_verifier`, authenticating by the
stored `tokenEndpointAuthMethod` — and stores tokens.

→ **Verify:** unit tests for — `resource` is present in **both** the authorization URL and
the token request, and equals `auth.resource`; the three token-endpoint auth methods each
produce the right request shape (body params, Basic header, neither); DCR runs only when
`registration_endpoint` exists and no `client_id` is stored; a replayed `state` is
rejected; a `state` belonging to another user is rejected; ownership lost between authorize
and callback is rejected; `code_challenge` is the S256 of the stored verifier;
`redirect_uri` is built from runtime-settings `publicBaseUrl` and never from the request.

### P4 — Dispatch

`buildMcpTools` asks `deps.mcpAuth.headersFor(version.projectName, mcp.name)` for servers
with `auth.type === "oauth2"` and layers the result over the merged headers (D4). Refresh
happens here, under T2's margin and T1's conditional write.

Discovery and tool calls that come back 401 mark the connection `needs_reauth` and warn in
those words (D7), instead of reporting the server as unreachable.

→ **Verify:** a run with a connected project sends `Authorization: Bearer …` (assert on the
session factory fake); an unconnected project yields the `warning` and no tools from that
server, and the run still completes; a near-expiry token triggers exactly one refresh; a
token comfortably inside the margin triggers **none** (T2 — this is the test that keeps the
discovery cache working); a concurrent-refresh test asserts one valid token survives and
status stays `connected`; a 401 from discovery produces a reconnect warning and
`needs_reauth`, distinguishable from the existing unreachable warning.

### P5 — Console

Project page gains a Connections section listing OAuth-required servers bound by any of the
project's versions, with status and Connect/Disconnect. The version editor's MCP picker
shows the status inline and links there.

→ **Verify:** UI is not covered by the test suite — check it by hand against `pnpm dev`
with a real Slack app, and state plainly in the report that this is what was done.

### P6 — Negative discovery cache

Cache discovery *failures* for a short TTL in `discoveryCache.ts`, reusing the stored reason
as the warning.

Separate in origin — it predates this feature — but this feature makes it routine: an
expired connection currently means every message re-pays a failing handshake before its
first token, forever.

→ **Verify:** extend `tests/mcpDiscoveryCache.test.ts` — a second call within the TTL makes
no request and reuses the reason; the entry clears on `invalidateMcpDiscovery`.

---

## Security checklist

This touches authentication and stored secrets, so treat it as blocking.

- [ ] `clientSecret`, `accessToken`, `refreshToken`, `codeVerifier` are AES-256-GCM
      encrypted at rest (`enc:v1:`) through `SecretCipher` — never `node:crypto` directly
      from application code
- [ ] They are masked on read and never appear in any GET response
- [ ] **No reveal endpoint.** The owner supplied the client secret and tokens have no reason
      to be displayed; do not copy the A2A-key/project-token reveal pattern here
- [ ] Nothing above is ever logged, including inside error messages
- [ ] `state` is generated with `randomUUID()` or `crypto.randomBytes`, is single-use via a
      conditional delete, carries a 10-minute TTL, and is bound to both user and project
- [ ] The callback re-checks project ownership at callback time, not only at authorize time
- [ ] PKCE `S256` is mandatory — never send a bare `code_verifier` or omit the challenge
- [ ] `resource` (RFC 8707) is sent on both the authorization and token requests. This is a
      security control, not a formality: it is what stops a token issued for one MCP server
      from being replayed against another
- [ ] `redirect_uri` is assembled from runtime-settings `publicBaseUrl`; no value from the
      request ever reaches it (open-redirect)
- [ ] Authorization, token, registration and discovery URLs all pass
      `urlPolicy.assertAllowed` (SSRF) **and** are `https:` — reject `http:` even when the
      SSRF guard would allow it, per the spec's transport requirement
- [ ] A token obtained for one registry entry is never sent to another; the connection is
      keyed by server name and the resource is pinned to `auth.resource`
- [ ] Connection reads and writes are owner-gated via `assertProjectOwner`; registry
      mutations stay `withAdminAuth`

---

## Out of scope

Do not build these; mention them if the work suggests they are needed.

- Multiple connections to one server from one project (D5)
- Refreshing a token mid-run in response to a 401; T2's margin makes it unreachable, and
  D7 says what to do instead
- Migrating existing static-header MCP entries; both mechanisms coexist
- Authorization for stdio MCP servers — the spec explicitly excludes them, and this
  codebase only speaks streamable HTTP
- Acting as an OAuth *resource server* for our own A2A/agent endpoints; unrelated surface

---

## Report when done

State what was verified and how, what was not, and the residual risk. If a phase was
finished but its verification could not run, say which and why. A "done" without a passing
check behind it is worse than an honest "unverified".
