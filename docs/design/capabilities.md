# Capabilities

What a run can reach beyond its own prompt: skills delivered by progressive disclosure, the
global catalog a version may search at dispatch, and the memory that outlives the run — which
is not this app's to store.

The servers those capabilities are bound to are [mcp.md](mcp.md). Choosing an embedding model
and the floor a search cuts at are
[CONFIGURATION.md](../CONFIGURATION.md#choosing-an-embedding-model); where discovery sits
relative to the PII filter is [SECURITY.md](../SECURITY.md#pii-filtering-and-where-it-stops).

## Skills

A skill is markdown behaviour instructions delivered by **progressive disclosure**: the system
prompt lists a name + description table only, and the model calls the builtin `Skill` tool to
load the `SKILL.md` body — or a specific attachment via `file_path`. The body is served with
its **attachment paths named after it**, and a `file_path` that cannot be served names them
too: `file_path` is a free-text guess, so a skill whose SKILL.md happens not to mention
`references/api.md` had that file stored, indexed and unreachable. That is the same answer an
unknown agent, an unknown image id and an unknown skill name already get, one level down.

```ts
Skill { name, description, content (markdown), files?: { path, content }[],
        source?, createdAt, updatedAt }
```

`source` marks skills synced from the plugins repo (`github:<repo>#<plugin>` — the repo and
the plugin that declared it) — and it is what tells an orphan from an entry someone wrote in
the console, so the sync stamps what it creates and never reports a name it did not. `files`
are attachment files collected under the skill root.

The plugins sync (`syncPluginsFromSnapshot`, `src/application/plugin/syncPlugins.ts`) reads
an [Agent Plugins 1.0.0](https://agent-plugins.org/) repository (`PLUGINS_REPO`): every
directory holding a `plugin.json` is one plugin (a root nested inside another is refused),
and each plugin's skills are the immediate children of its `skills/` directory holding a
SKILL.md that conforms to the Agent Skills spec — frontmatter `name` matching the directory,
`description` present and within the spec's cap. Interpretation of `plugin.json` and
`mcp.json` is domain-owned (`src/domain/plugin/types.ts`); the GitHub client only fetches.
Supported text attachments are collected under each skill root
(`src/domain/skill/files.ts`: `ALLOWED_SKILL_FILE_EXTENSIONS`), bounded by per-file,
per-skill and file-count caps (64KB / 200KB / 20 — the values are in
[CONFIGURATION.md](../CONFIGURATION.md#limits-fixed-in-code)) and excluding symlinks. `file_path` is normalised and confined
to the skill root: no absolute paths, no `..`, no cross-skill access. An overwrite replaces
the whole skill item, so stale attachments drop with it; skipped files are reported with
reasons.

Each plugin also becomes a row (`Plugin` in `src/domain/plugin/types.ts`: manifest metadata
plus the component names it declared) — the one thing the sync upserts unconditionally,
because nothing on it is operator-authored. The console's Plugins page lists them.

**The repository owns what it declared; a person owns deletion**
(`src/domain/sync/types.ts` owns the skip vocabulary; the kind-qualified report lives in
`src/domain/plugin/sync.ts`): a repo-sourced entry — including one adopted from another
origin, provenance rewritten with it — is brought to the repository's version automatically,
while an orphaned one is deleted only when the caller names it. See the sync contract in
[API.md](../API.md#registry-and-integration-operations). Hand-registered entries are never
touched.

## Capability catalog

One **global** index over everything a run could reach — every skill, every MCP server and the
tools it offers, every external agent. Not per project: which of them a given run may use is
decided at dispatch from its version's bindings, and an index that had already made that
decision would need rebuilding whenever a project changed.

```
CapabilityEntry { kind: 'skill' | 'mcpServer' | 'mcpTool' | 'agent', name, toolName?, description }
key = kind#name  (or kind#name#toolName)          — src/domain/catalog/types.ts
```

An MCP server appears **twice over**, and the two answer different questions. A `mcpTool` entry
is what a request matches — "leave a comment on a PR" lives in a tool's description and nowhere
else — while `mcpServer` is what a version can actually bind. A server that refuses discovery
still gets the second one: an OAuth server nobody has connected looks exactly like a broken one
from here, and it is precisely the entry someone needs in order to connect it.

`reindexCatalog` rewrites the whole index and **then** deletes what it did not write. That order
is the contract: a crash between the two leaves stale entries the next tick clears, where the
reverse leaves a window with a live capability missing and searches silently under-answering. It
runs on the same CronJob token as the schedule scan and the plugins sync
(`POST /api/catalog/reindex`), and never on a registry write — a save that succeeded must not
500 because indexing failed, and the catalog only affects what a run *discovers*.

**A completed plugins sync is the one exception**, and the difference is what a failure would
cost. A sync is the single event that moves the most of the registry at once — a merge can add,
rename or retire a dozen skills and servers together — so waiting up to an hour would mean runs
discovering a skill the registry no longer has. By the time it reindexes the sync has already
committed and its report is already persisted, so a failure changes nothing and is logged and
swallowed; the next tick repairs it. It is also the only way a **local** deployment refreshes at
all, since the CronJob exists only in the cluster.

Search takes **several queries**, because a run has two things to say about what it needs: the
version's system prompt (what this agent is generally for) and the newest user turns (what it
is being asked now — a short window rather than the last turn alone, because a follow-up like
"review the first one" names nothing while the turn before it named everything, and the
capability the conversation was already using must not stop being found the moment the user
refers back to it). Averaging them into one point describes neither. Each entry keeps its best
score rather than the sum, so breadth does not outrank fit. Two corrections sit on top of the
vector: a query naming something exactly is boosted over a description that merely reads like
it, and results are cut by **two floors, whichever is higher**. The ratio (a fraction of the
best score) keeps a strong field from dragging in its weak tail; absolute cosine numbers do not
survive an embedding-model change, so that part cannot be absolute. But a ratio alone cannot
see that *nothing* matches — half of the best bad score is still a bad score, and a request the
catalog has nothing for comes back full. `DEFAULT_MIN_SCORE` is the floor that says no.

Both numbers belong to the **embedding model**, not to the search, and they do not transfer —
see [CONFIGURATION.md](../CONFIGURATION.md#choosing-an-embedding-model) for the measurements that
put this deployment on Cohere v4. The short version: its registry is described in English and
queried in Korean, and that is the one case the alternatives cannot resolve.

**Each query is ranked and cut against its own best, then the survivors are merged.** Sharing
one cut across both lets the stronger query erase the weaker: a system prompt reading "당신은
Slack 어시스턴트" puts `slack` at 0.583, so a ratio taken over the union sits at 0.408 and
drops `github` at 0.393 — the entry the request actually named. Two queries asking different
questions cannot share a proportional cut.

**A server is one candidate, scored by the best evidence from either index.** The two indexes
are merged into a candidate per server name, each keeping the higher of its tool-hit and
server-hit scores — comparable because they share one embedding space and each kind was
already cut against its own best. Source order would not do: with every tool hit outranking
every server hit, a persona prompt's incidental tool matches filled all three slots ahead of
the servers the request itself named. What a tool hit knows that a server hit does not — *which*
tools matched — becomes the binding's `tools` narrowing rather than a ranking privilege, so a
discovered server does not spend the run's tool budget on the rest of its catalogue; a
candidate only the server index reached is bound whole and the dispatch-time listing decides.

Both searches are **oversampled past the binding cap** (`DISCOVERY_LIMITS` in
`src/application/execution/bindings.ts`: tools at four times the server cap, servers at three
times) because the walk skips candidates — an OAuth server this project has not connected, an
entry deleted since the index was built — and **a skipped candidate must not cost a slot**.
Sized at exactly the cap, one unconnected high scorer starved the servers the request asked
for. Each list is then **sorted by name, not by score**: order carries no meaning downstream,
but it decides which colliding MCP tool keeps its bare name (alias allocation walks the servers
in list order, so a swap re-routes a tool call the history replays) and the byte layout of the
system prompt, which the provider's prompt cache keys on. Scores rank differently for every
message; names do not.

**Discovery at run time is opt-in and strictly additive.** `parameters.dynamicCapabilities`
turns it on; `resolveRunTools` then appends what it finds to the version's own lists *before*
resolving, so every later stage — the prompt tables, the tool enums, the reachability checks —
treats bound and discovered alike. Bindings are never displaced, reordered or truncated. An MCP server whose credentials are a per-project OAuth
connection is added **only where the project has already connected it** — authorizing one in
the console says this project may use it, and discovery reads the connection rows rather than
resolving the credential, which would refresh tokens and make it a writer. A failure of the
catalog degrades to the bindings with a warning rather than failing the run — as does a version
that asked for discovery on a deployment with no catalog, which is otherwise indistinguishable
from one where the search simply found nothing.

**What was *found* is not a warning.** `resolveRunTools` returns it separately, as `discovered`.
It was a `warning` chunk, which meant every healthy run of a discovery-enabled version reported
one — a yellow alert on every chat turn, a non-empty `warnings` in every answer, and anything
keying on "did this run report a loss" firing on all of them. `collectedWarning` owns what a run
lost, and finding a capability is the opposite. A run logs it; the Playground preview renders it
on its own, which is the one place an author cannot see it any other way — what a run actually
*used* is already in its tool traffic.

The engine knows none of this. Discovery widens the arrays `assembleAgentRun` already receives —
and the version it hands back, so `buildSubagentRunner` builds its dispatch map from the same
list the model was told about. Given the caller's own version instead, a discovered agent sat in
the transfer enum and answered `Unknown agent` the moment the model used it.

## Memory

What outlives a run is **not this app's to store**. A memory server — mcp-memory, an ordinary
registry entry — keeps a project's decisions, conventions and facts and offers them as tools
(`recall`, `remember`, `list_memories`, `forget`), scoped by the tenant header every run sends
and, since the run learned which conversation it is in, told the conversation too
(`X-Conversation-Id`, [MCP](mcp.md)). A native store beside it would be a second answer to "what
does this project remember", and the platform's boundary for what a run reaches is MCP.

What the app adds is the one thing a tool cannot do for itself: **ask before the model has to
think of asking.** A version that opts into `parameters.memoryRecall` has the run call `recall`
on every bound server that offers one — by that name; a convention rather than a setting,
because the setting would only ever name this string; and *bound* means the version's own
`mcpList`, not a server discovery added for this request, whose `recall` stays a tool the
model may call but is not handed every request unasked — with the newest user turn as the query,
before the first token, and put what came back into the system prompt as a *What you remember*
block, after the clock and the caller and ahead of the capability sections: a fact about the
run, framed as background rather than as instructions because a memory is stored text and
stored text is what a model is talked into things by. `recallMemories`
(`src/application/execution/memoryRecall.ts`) owns all of it — the tool name, the query bound,
the prompt budget, the timeout, and the join across several servers — and the engine receives
the result as an input field (`remembered`), exactly as it receives the caller. A child
transferred to decides for itself, from its own version, and asks with the transfer message.

Three properties are load-bearing. **A recall never ends a run**: a server that fails, times
out, or answers `Error:` is a `warning` and the run goes on without it — the answer is worth
more than the recollection. **The loss is named**: a version with the flag on and no bound
server offering `recall` warns that it started without a memory, rather than silently reading
as a version that remembers. And **the preview says what it cannot show**: what is recalled
depends on the request, which a preview does not have, so it reports the missing block instead
of showing a prompt one block short. The tools stay offered as before; the recall is in
addition, and the model may still `remember` and `recall` mid-run.

Two decisions this leaves open, on purpose. *Where a memory attaches* — to the project (what
mcp-memory does today) or to the conversation — is the server's, which now has both keys.
And *what is written back* stays the model's, through `remember`, with the conversation and
the tenant on the request as its provenance; the run itself never writes.

