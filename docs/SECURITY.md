# Security

Who may do what, how credentials are stored and handed out, and where the boundaries are
that this app enforces — and where they end.

Related: [CONFIGURATION.md](CONFIGURATION.md) for the variables named here,
[API.md](API.md) for per-endpoint authorization, [ARCHITECTURE.md](ARCHITECTURE.md) for how
the pieces fit together.

## Authentication

Better Auth 1.6 with **Google OAuth only**, over a custom DynamoDB adapter on the single
table (`src/infrastructure/db/authAdapter.ts`). Sign-in is restricted to
`ALLOWED_EMAIL_DOMAINS`; an empty list allows any domain, which `STAGE=alpha|prod` refuses
to boot with (see [Boot-time validation](CONFIGURATION.md#boot-time-validation)).

Auth unique fields (email, token) are claimed transactionally with a dedicated lock item
rather than checked-then-written. `GSI2` remains as a compatibility lookup for rows created
before the locks existed.

### Two gates, on purpose

| Surface | Gate | What it decides |
|---|---|---|
| Pages | `src/proxy.ts` | Redirect a signed-out visitor to `/login?next=…` |
| API routes | `withAuth` / `withAdminAuth` (`src/lib/session.ts`) | 401 without a session; hands `SessionUser` to the handler |

`src/proxy.ts` is the single owner of which pages are public — `/` and `/login`. Everything
else the matcher reaches needs a session, so **a new route defaults to protected**. That
direction is deliberate: forgetting to list a public page produces a redirect a user reports
in a minute, while forgetting to list a private one fails silently.

The page gate checks the *presence* of the session cookie, not its validity. Verifying it
would mean a session read on every navigation and still would not be the authorization
decision — that stays server-side in `withAuth` and `assertProjectWritable`, which see the
request that actually touches data. A present-but-invalid cookie therefore reaches the page
and gets its 401 from the API behind it; what the gate removes is the ordinary signed-out
case, which used to hand a visitor the whole console plus an error box.

`/api` is outside the matcher: those routes authenticate themselves and must answer a
programmatic caller with a 401, never an HTML redirect.

The `next` parameter arrives from the address bar, so `/login` reads it back through
`safeNextPath` (`src/shared/safeNextPath.ts`). `//host` and `/\host` have to be rejected or
the sign-in flow becomes an open redirect.

## Authorization model

**Projects are a shared catalog.** Any signed-in user may read and run any project. Only
mutations are gated.

| Resource | Read | Write |
|---|---|---|
| Project, versions | any signed-in user | owner or configured admin (`assertProjectWritable`) |
| Project traces | owner or configured admin | — |
| Project Slack config | owner or configured admin | owner or configured admin |
| Project API token, triggers, MCP connections | owner or configured admin | owner or configured admin |
| Per-caller usage (`usage/actors`) | owner or configured admin | — |
| Project usage totals | any signed-in user | — |
| Skills / MCP servers / external agents | any signed-in user | admin (`withAdminAuth`) |
| App settings | admin | admin |
| Chats | owner only (non-owner reads 404) | owner only |

Traces and the Slack config are gated on *read* as well because they expose other users'
runtime inputs/outputs and masked credential edges. Project *totals* stay open because the
catalog is shared; a breakdown by caller names individuals, so `usage/actors` does not.

### `isAdminEmail` vs `isConfiguredAdmin`

Two different admin questions, both in `src/lib/runtime-settings.ts`, and they must not be
swapped:

| Predicate | Question | Empty `ADMIN_EMAILS` means |
|---|---|---|
| `isAdminEmail` | May mutate shared registries and app settings? | **no restriction** — any signed-in user |
| `isConfiguredAdmin` | May write a project owned by someone else? | **nobody** |

Using the first for project ownership would hand every signed-in user write access to every
project on a deployment that never set `ADMIN_EMAILS`. Both flags are sent to the browser by
`GET /api/me` under the same two names, because the console gate for "may I edit this
project" must mirror `assertProjectWritable` exactly — reading `isAdmin` there once offered
every user an edit form for every project, and every save 403'd.

The admin override is checked *inside* `assertProjectWritable` rather than threaded in by its
twenty-odd callers: the rule is "owner or admin", and a flag one caller forgot to pass would
silently narrow it back to owner-only on that path alone. The function is named for that rule
and not for the owner — anything that genuinely needs **ownership** (attribution, whose
credentials to dispatch with, whom to notify) reads `project.ownerEmail`.

Two consequences of the override are handled rather than assumed away:

- It is **logged** — `[authz] admin … is acting on project …` — because the write can destroy
  the row that would have identified who made it, and a project's API token authenticates
  *as its owner*, so an admin reveal leaves that line plus `[token] … revealed by …`.
- The settings read it needs **fails closed**: a settings-store outage denies the override
  rather than turning a non-owner's deterministic 403 into a 500.

## Secrets at rest

Every stored credential — MCP server headers, external-agent headers, per-version header
overrides, Slack bot token and signing secret, the app-wide A2A key, project API tokens,
webhook trigger secrets — is AES-256-GCM encrypted with `AES_ENCRYPTION_KEY` and stored
under an `enc:v1:` prefix (`src/infrastructure/crypto/secretEncryption.ts`).

### Masking on read

Reads return a **length-preserving mask**, so the console can show *which* credential is set
without showing it:

| Plaintext length | Revealed |
|---|---|
| < 9 chars | nothing (`*` × length) |
| 9–20 chars | first 2 and last 2 |
| ≥ 21 chars | first 4 and last 4 |

The two revealed edges are never allowed to meet. Revealing edges needs the plaintext, so
masking decrypts — only inside the admin/owner-gated read views that call it, and a
decryption failure hides the value entirely rather than erroring. A value short enough that
nothing would be revealed is never decrypted at all, decided from the ciphertext length
(AES-GCM preserves plaintext length).

### Masks on write

A masked or empty value on update **preserves the stored secret**; a masked value under a key
with no stored counterpart is **dropped**. A mask can only confirm an existing secret, never
create one. `null` in a header-override map passes straight through as an explicit removal —
a removal is not a secret.

### Reveal endpoints

Three secrets this app issues can be read back in plaintext:

| Secret | Endpoint | Who |
|---|---|---|
| App-wide A2A key | `POST /api/settings/a2a-key/reveal` | admin |
| Project API token | `POST /api/projects/{name}/token/reveal` | owner or admin |
| Webhook trigger secret | `POST /api/projects/{name}/triggers/{trigger}/reveal` | owner or admin |

All three are **POST although they read**: the response body is a live credential, so it
stays out of caches, browser history and prefetches. Every reveal is logged server-side with
the caller's email.

These three are therefore stored **encrypted rather than hashed**, which is a deliberate
trade: the datastore alone is not enough to use one, but the datastore *plus*
`AES_ENCRYPTION_KEY` is. **Treat that key as the thing standing between a table dump and
live project credentials.** Project tokens issued before revealing existed are stored as a
SHA-256 hash instead — they still verify, but cannot be shown again, so the console offers
regeneration.

### Generated secret prefixes

Secrets Agent Studio issues carry a prefix naming product and kind
(`src/shared/generatedSecret.ts`), the way `ghp_`/`gho_` do for GitHub, so a leaked string is
traceable to what it opens:

| Prefix | Secret |
|---|---|
| `asa_` | app-wide A2A key (admin-managed) |
| `ast_` | project API token (owner-managed) |
| `asw_` | webhook trigger secret (owner-managed) |

The random part is 32 bytes (256 bits), so the prefix costs no entropy that matters.
Verification never looks at the prefix, so tokens issued under the older `sk_proj_` spelling
keep working.

A project token's display mask is computed at generation and stored beside the ciphertext, so
listing a token costs no decryption; the mask carries only the prefix and the edge characters,
never enough to reconstruct the token.

## Request authentication for machine callers

Four surfaces authenticate without a session cookie:

| Surface | Credential | Verification |
|---|---|---|
| Execution endpoints (`predict`, `chat/completions`, `agent`) | `Authorization: Bearer ast_…` | Decrypt-and-compare in constant time (or hash compare for a legacy token), scoped to the `{name}` in the path; runs **as the project owner** (`authenticateExecution`) |
| Slack events | Slack signing secret | HMAC + `timingSafeEqualString`, 5-minute replay window, per-project secret |
| Inbound A2A | `X-A2A-Key` | Constant-time compare against `A2A_API_KEY`; unset disables the endpoints |
| Webhook triggers | `X-Trigger-Secret` | `cipher.decryptEquals` (constant time) |

The trigger secret is compared **before** the enabled flag is read, so a disabled trigger
cannot answer a wrong secret differently from an enabled one — that difference is an oracle
for which triggers exist.

Constant-time comparison has one owner, `src/shared/timingSafe.ts`, pinned by
`tests/architecture.test.ts`.

Replay protection: Slack events are deduplicated exactly-once by `event_id` (conditional put,
24h TTL) whose claim is a **lease** settled afterwards, so an instance that dies mid-processing
leaves a reclaimable claim rather than an event recorded as handled by nobody. Webhook
deliveries claim their `Idempotency-Key` the same way.

## Outbound requests (SSRF)

Operator-registered URLs — MCP servers and external agents — are validated by
`src/infrastructure/net/ssrfGuard.ts` at **both registration and dispatch**. Rejected:
non-`http(s)` schemes, and hosts resolving to private, loopback, link-local (including the
`169.254.169.254` cloud-metadata address) or otherwise reserved ranges.

Dispatch goes through `fetchPublicUrl` (`src/infrastructure/net/publicFetch.ts`), which is
the single outbound boundary:

- DNS is re-resolved and re-checked on **every request and every redirect hop**, narrowing
  (though not fully closing) the DNS-rebinding window between registration and use.
- The connection is pinned to the checked address.
- Native redirect-following is disabled and **cross-origin redirects are refused**, so stored
  credentials cannot be forwarded to another host.
- Dispatchers are pooled per `origin|pinned address` for connection reuse. This caches
  **transport only** — the guard still runs per request, so a host that starts resolving
  privately is rejected before a pooled dispatcher is reached, and a host resolving elsewhere
  gets a different key.

Any public URL is allowed. Register only trusted endpoints.

### Declared internal hosts

On a cluster, the MCP servers this app is *meant* to call are private by
construction — a Kubernetes Service resolves to a ClusterIP the guard rejects.
`MCP_INTERNAL_HOST_SUFFIXES` is how a deployment says which names those are:

```
MCP_INTERNAL_HOST_SUFFIXES=agent-mcps.svc.cluster.local
```

A host under a declared suffix skips the public-URL guard at registration and at
dispatch. **The blocked address ranges are not widened** — every other entry
still faces exactly the check it did before. This is a second narrow exception
alongside managed loopback, not a loosening of the guard.

Its narrowness is the whole design, and each part is pinned by
`tests/internalHosts.test.ts`:

- **Configuration only.** The list comes from the environment. A registry entry
  cannot name its own exemption, and it is deliberately *not* a runtime setting:
  widening the outbound boundary should take a deploy, not a form submitted by
  whoever holds admin at the time.
- **Label-anchored.** `agent-mcps.svc.cluster.local` admits
  `mcp-url-fetch.agent-mcps.svc.cluster.local` and refuses
  `evil-agent-mcps.svc.cluster.local` — the near-miss that a plain "ends with"
  would let through. A leading dot is accepted and means the same thing.
- **No single-label suffix.** `local` or `internal` would admit a whole namespace
  of names; far more likely a typo than an intent, so it is not honoured.
- **Never an IP literal.** The exemption is for a name someone published. An
  address has no name to match, so a private address still has to earn its way
  through provenance.
- **`http(s)` only**, and userinfo cannot smuggle the suffix past the host check.

What it costs: a host under that suffix is reachable by any URL an admin can
store, which is the capability the guard otherwise removes. Keep the suffix as
specific as the namespace you actually run those servers in.

### The managed-loopback exception

A managed MCP server (`runtime: "managed"`) is a container this app started on its own host
and reaches at `127.0.0.1:<port>` — an address the guard correctly rejects for anything an
operator types. Trust rests on **provenance** instead: the provisioner recorded that address
after binding the port.

`isManagedLoopback` (`src/domain/mcp/types.ts`) is the only place that decides the bypass
applies, and it is narrow on purpose. The entry must claim `managed` **and** carry a literal
loopback address:

- A hostname that resolves to `127.0.0.1` is refused — it can resolve elsewhere between check
  and request.
- A `remote` entry pointing at loopback is refused — that address was typed.
- The registry refuses to move a managed entry's URL.
- The lifecycle use case refuses to store a non-loopback address even when the provisioner
  reports one, and stops the container it named.

The provisioner takes an image reference, a port and an optional **argv array**, never a
shell command. The local adapter passes argv directly to Docker; the SSM adapter shell-quotes
every argument before assembling its command.

## MCP OAuth

Registry entries may carry an `auth` block discovered once at registration (RFC 9728
protected-resource metadata → RFC 8414 authorization-server metadata), both re-validated
through the URL policy and required to be `https`. **The run path never fetches a well-known
document.**

Credentials are **per project**, in their own `PROJECT#<name> / MCPCONN#<server>` item — not
on the version (a snapshot of configuration history) and not on the project item (whose
`updatedAt` is the optimistic-concurrency condition for publish). That split is what lets one
shared registry entry serve a different provider app per project.

Enforced properties:

- **PKCE S256 is mandatory.** `state` is single-use with a 10-minute TTL.
- **RFC 8707 `resource`** is sent on every authorization and token request. The spec makes it
  unconditional, and it is what stops a token issued for one MCP server being replayed
  against another.
- **RFC 9207 `iss`** is validated before the code is redeemed (SEP-2468). The expected issuer
  is recorded on the pending-state item beside the PKCE verifier — *not* read back off the
  registry entry, which a re-discovery may have changed — and compared **literally**: no case,
  port, trailing-slash or percent-encoding normalisation, each of which is another way for two
  issuers to compare equal. A missing `iss` is fatal only where the server's metadata
  advertises `authorization_response_iss_parameter_supported`. The same check runs on error
  responses, so provider-controlled `error_description` text is never relayed from a redirect
  this app cannot attribute.
- **Issuer binding on the credentials** (SEP-2352): a connection's client credentials carry
  the issuer they were registered with, and its tokens carry the `resource` they were minted
  for. Both are checked before anything is handed out — on the refresh path *and* on the path
  that only reads a live token, because a bearer token has an audience and serving one
  unchecked is the same mistake as spending the client secret.
- **Editing an entry's URL drops its `auth` block outright.** The block was read out of the
  old address's well-known documents. The entry falls back to its own headers until an admin
  re-runs Discover; once they do, the two checks above catch every connection that belonged to
  the old server. Deleting and recreating an entry under the same name is caught the same way
  — which matters, because the registry is admin-owned while connections are owner-owned and
  the only thing joining them is the name.
- Dynamic registration (RFC 7591) declares `application_type: "web"` (SEP-837) rather than
  leaving the OpenID Connect default to apply. A public client with no secret sends `none`
  whatever the server's metadata preferred.
- The callback **re-checks project ownership**, because it can change while the user is at the
  provider.

Refresh is a compare-and-set on the stored refresh token: providers that rotate them revoke
the previous one, so the loser of a race uses the winner's token. Only a **refused grant**
marks a connection `needs_reauth`; a 5xx or timeout leaves it alone. (Refresh timing is a
design constraint rather than a security one — see
[ARCHITECTURE.md](ARCHITECTURE.md#oauth).)

A connection **supplies** credentials rather than gating the server. The resolved token is
applied last at dispatch — over the registry entry's headers and the version's overrides — so
a version cannot substitute its own `Authorization` for the project's connection. When no
connection is available, the server still runs on whatever those headers hold; it is dropped
with a warning only when they hold nothing.

## PII filtering, and where it stops

Opt-in per version via `parameters.piiFiltering`. Emails and phone numbers in outbound
messages and variables are replaced with reversible, format-preserving `[[PII:…]]` tokens
before every LLM dispatch, and the originals are restored in responses — streaming included,
with token-boundary buffering — so the model never sees the real values. The mapping carries
across subagent transfers.

**The boundary is the LLM channel and the engine's own context, not every outbound call.**
When the model invokes an MCP tool, `callMcpTool` receives the **restored** arguments — a tool
asked to email `a@b.com` needs the address, not a token. A connected MCP server therefore
still sees the PII it is passed. (A subagent transfer is the opposite: the child agent
receives the masked message.) Review MCP server registrations on their own terms;
`piiFiltering` does not cover them.

Detection is regex-based and covers emails and phone numbers only. Treat it as best-effort
masking, not a guarantee. Off is byte-identical to the unfiltered path.

## Caller context

Opt-in per version via `parameters.callerContext`. With it on, a Slack run tells the model who
is asking — display name, timezone, and the avatar's URL — and labels each speaker when a thread
holds more than one human.

**A name is PII that `piiFiltering` does not mask.** Its patterns match emails and phone numbers,
and a person's name matches neither, so anything the caller block carries reaches the model as
written even with filtering on. That is why the block carries **no email**, and why this is a
per-version opt-in rather than default behaviour: turning it on is a decision to put real
people's names into prompts and into whatever the provider logs.

The opt-in gates the lookup as well as the prompt. A version with it off causes no `users.info`
call at all, so a project that has not opted in never sends a member's id to Slack's profile
API. Resolved profiles are cached in memory per workspace (an hour; a failure, a minute) and are
never persisted.

## Data exposure and retention

- Traces store **bounded metadata only** — character counts, tokens, cost, duration, subagent
  trace ids. Raw prompts and tool results are not persisted.
- `/api/metrics` names no project, user or model. The only label any metric carries is a
  histogram's `le`.
- Log lines carry a run correlation id, never prompt content.
- Traces, usage rows, chats, trigger deliveries and inbound A2A tasks all expire via DynamoDB
  TTL — see [OPERATIONS.md](OPERATIONS.md#row-retention).

## Operational notes

- **Rotate, don't just edit.** A leaked A2A key, project token or trigger secret is rotated
  from the console (`POST …/a2a-key`, `POST …/token`, `PUT …/triggers/{id}` with
  `rotateSecret: true`); the previous value stops working immediately.
- **Settings propagation is not instant.** A demoted admin or a rotated A2A key keeps working
  on instances that did not serve the write until their settings cache expires
  (`SETTINGS_CACHE_TTL_MS`, default 5s). Immediate cross-instance revocation would need a
  shared invalidation signal, which does not exist yet.
- **AWS credentials come from the task/instance role** — never bake keys into the image.
