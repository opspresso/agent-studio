# External agents and A2A

A registry entry for an endpoint outside this deployment, and the protocol both directions of
which are served: inbound, where a published project is an agent someone else calls; outbound,
where a transfer reaches one.

How a caller authenticates to the inbound surface is
[SECURITY.md](../SECURITY.md#request-authentication-for-machine-callers); the JSON-RPC surface
is [API.md](../API.md#a2a-inbound).

## External agents (registry)

```ts
ExternalAgent { name, url, protocol?: 'openai' | 'a2a' (absent = openai),
                description, headers (encrypted like MCP), createdAt, updatedAt }
```

Usable as `type: 'remote'` subagents and via the test-message endpoint. `url` is SSRF-guarded
like MCP.

## A2A

**Inbound**: on a deployment where the surface is enabled (the shared `A2A_API_KEY` or at
least one named client key — otherwise both routes answer 503), every project with a
published version serves a public Agent Card and a JSON-RPC endpoint. Task state is persisted
per project in the single table (`createA2aTaskStore`), so it
survives redeploys and is shared across instances, with a terminal-state-guarding conditional
write so a concurrent complete/cancel never regresses a finished task. Rows are TTL-expired.

**Outbound**: an agent registered with protocol `A2A` and its Agent Card URL. Custom headers
are sent on card resolution and RPC calls. A transfer asks for **`message/stream`** and folds
the events back into the task a blocking send would have returned, so both paths are read by
the same two extractors rather than by two copies of the artifacts-over-status rule. A card
without `capabilities.streaming` falls back to one blocking `message/send` — the SDK refuses
before any request goes out, which is what makes the fallback safe. **The bound is on silence,
not on the whole exchange**: a remote investigation may run far longer than any gap between its
updates, and the total is capped by the run's own deadline. Past the first event a broken
stream is reported rather than retried, since the remote is already working and a second send
would run the delegation twice.

**A transfer continues the remote conversation.** The protocol's mechanism is `contextId`: the
remote mints one on the first message and groups later messages that carry it. Which one to
carry is answered by `RunOrigin.conversation` — the same key the MCP header names — through a
row per *transferring project × agent × conversation* (`REMOTECTX#…`, owned by
`RemoteConversationRepository`, written by `runRemoteSubagent`): the reply's `contextId` is
remembered after every successful transfer and sent back on the next one from the same
conversation. Keyed by project on purpose — two projects' bots answering in one Slack thread
are two callers of the remote agent, and one context would show each the other's turns — and
by our conversation rather than by the remote's, because the remote's key is what is being
looked up. It is a hint with a week's TTL, refreshed on use: losing one costs the next transfer
a cold start, which is exactly what every transfer got before the row existed, and a store
that cannot be read starts cold rather than failing the transfer. A transfer that *continued*
a context and failed drops the hint — the remote may have retired the context, and a wrong hint
kept costs every transfer until it expires where one dropped costs a single cold start. It is
not retried on the spot: the remote may already be working, and a second send would run the
delegation twice. An OpenAI-shaped remote has
no conversation to continue and is sent none. A run without a conversation — a firing, an API
call that sent no `X-Conversation-Id` — transfers cold, as before.

The transcript still travels on a continued transfer. The two are not the same thing: the
transcript is what was said *here* since the last hand-off — the turns the remote never saw —
while the remote's context is what it said and did; a second question carries both, and the
overlap is the earlier turns, bounded by the transcript's own 8,000 characters. Dropping the
transcript on continuation would lose the local turns for the sake of that overlap, and a
remote that keeps no history of its own — this platform's inbound side runs each message
alone — would then see nothing.

SSE framing differs by protocol: `sseResponse` uses the OpenAI `[DONE]` terminator,
`sseResponseRaw` uses A2A JSON-RPC framing (`src/app/api/_lib/sse.ts`).

